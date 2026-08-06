// server/src/preview-forward.ts
/**
 * The one acquire → map-error → retain → proxy → release sequence every
 * route that forwards a request to a project's own preview child shares:
 * `preview-routes.ts`'s single `/preview/:projectId/*` route and
 * `compiler-routes.ts`'s dozen-plus `/__*` routes. Both used to carry their
 * own copy of this — byte-identical on the security-relevant parts — which
 * is exactly the kind of duplication that drifts silently. It matters beyond
 * tidiness because the divergence is already scheduled: a later change maps
 * `MissingApiKeyError`/`DisabledUserError`/`UndecryptableApiKeyError` onto
 * this handler, and that mapping must land in exactly one place, not two
 * that can quietly disagree (e.g. `/preview/:projectId/*` answering 500 for
 * a disabled owner while `/__regen` answers 403).
 *
 * `release` runs in a `finally`: a client that disconnects mid-request — or
 * a proxy call that somehow throws — must still free the slot, or one
 * aborted request pins the preview forever and `MAX_PREVIEWS` leaks down
 * over the life of the process. The forwarded path is `req.url`, VERBATIM —
 * see preview-routes.ts's module comment for the full account of why
 * stripping any part of it (a `/preview/<id>/` prefix, a query string) loops
 * the client against Vite's own base-redirect or breaks its HMR handshake.
 */
import { PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { proxyHttp } from "./preview-proxy.ts";
import type { ProjectHandler } from "./require-project.ts";
import { sendJson } from "./router.ts";

export function forwardToPreview(pool: PreviewPool): ProjectHandler {
  return async (req, res, ctx) => {
    let preview;
    try {
      preview = await pool.acquire(ctx.project, ctx.user.id);
    } catch (error) {
      // Capacity is the caller's problem to act on, and the message says
      // so. Anything else is ours, and gets a generic message: the
      // underlying error can carry a stack trace or (via buildChildEnv's
      // failure paths) something derived from the environment, neither of
      // which may ever reach a response body.
      sendJson(res, error instanceof PreviewCapacityError ? 503 : 500, {
        error: error instanceof PreviewCapacityError
          ? error.message
          : "could not start the preview",
      });
      return;
    }
    // retain/release BRACKET the proxy so the reaper cannot kill this
    // subprocess mid-request. release() runs in a finally so an aborted
    // or failed proxy call still frees the slot.
    pool.retain(ctx.project.id);
    try {
      // req.url, unmodified — see the module comment for why.
      await proxyHttp({ req, res, port: preview.port, path: req.url ?? "/" });
    } finally {
      pool.release(ctx.project.id);
    }
  };
}
