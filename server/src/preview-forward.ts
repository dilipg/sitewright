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
 *
 * The optional `billable` hook (task 3, "attribute the spend") is how
 * `compiler-routes.ts` attaches a per-request usage id to a billable
 * endpoint's forwarded request without a second copy of this
 * acquire/retain/proxy/release sequence: `setHeaders` reaches `proxyHttp`
 * (which applies it AFTER its own client-header strip, so the server's value
 * always wins), and `after` runs in the SAME `finally` as `pool.release` —
 * but, since FIX 3 (a whole-branch review), only when `proxyHttp` itself
 * reports that the exchange actually COMPLETED (see that function's own
 * comment). The claim this comment used to make here — "after the proxy
 * call resolves OR rejects, never before, since ... the child only returns
 * once the run is actually done" — was false: `proxyHttp` resolves early,
 * by design, on a client abort or `PREVIEW_PROXY_TIMEOUT_MS`, while the
 * orchestrator subprocess behind it may still be running and still
 * appending to its usage log. Ingesting unconditionally at that point read a
 * PARTIAL file and then deleted it, so every line the subprocess wrote
 * afterward landed in a file nobody would ever ingest again — silent
 * under-counting. `after` still runs whenever `proxyHttp` REJECTS (it never
 * does today, by that function's own contract, but nothing here depends on
 * that): a call that throws is treated the same as "completed" for this
 * gate, because a run that failed partway through still spent money and
 * `ingestUsageLog`'s own docstring says exactly that ("even when it
 * threw"). It is skipped ONLY for the specific case `proxyHttp` resolves
 * `{ completed: false }` — an exchange that settled without the upstream
 * ever finishing. `preview-routes.ts` never passes this option, so its own
 * behaviour is unchanged: `setHeaders` is `undefined` and `after` never
 * runs.
 */
import { PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { proxyHttp } from "./preview-proxy.ts";
import type { ProjectHandler } from "./require-project.ts";
import { sendJson } from "./router.ts";

type ForwardCtx = Parameters<ProjectHandler>[2];

export interface BillableForward {
  /** Merged onto the forwarded request's headers after the standard strip — see the module comment. */
  setHeaders: Record<string, string>;
  /** Runs in the same `finally` as `pool.release`, whether the proxy call resolved or rejected. */
  after: () => void | Promise<void>;
}

export function forwardToPreview(
  pool: PreviewPool,
  options?: { billable?: (ctx: ForwardCtx) => BillableForward },
): ProjectHandler {
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
    // Resolved once, before the proxy call, so the SAME id backs both the
    // header the child receives and the path `after()` ingests from.
    const billable = options?.billable?.(ctx);
    // retain/release BRACKET the proxy so the reaper cannot kill this
    // subprocess mid-request. release() runs in a finally so an aborted
    // or failed proxy call still frees the slot.
    pool.retain(ctx.project.id);
    // Defaults to true: a `proxyHttp` call that THROWS (never happens in
    // production — see that function's own "never rejects" contract — but
    // several tests script exactly this to stand in for a run that failed
    // partway through) must still ingest, because a run that errored halfway
    // still spent money (ingest-usage.ts's own docstring). The ONLY way this
    // becomes false is `proxyHttp` RESOLVING with `{ completed: false }` —
    // see the module comment.
    let completed = true;
    try {
      // req.url, unmodified — see the module comment for why.
      const result = await proxyHttp({
        req,
        res,
        port: preview.port,
        path: req.url ?? "/",
        setHeaders: billable?.setHeaders,
      });
      completed = result.completed;
    } finally {
      // Ingest AFTER the proxy call settles (success or throw), and even
      // when it threw — but only when the exchange actually COMPLETED (see
      // the module comment on why "settled" is not the same thing).
      // Skipping `after()` on an incomplete exchange leaves that request's
      // usage id unswept here; `usage-log-sweep.ts` clears it out of
      // `<tmpdir>/webgen-usage` at the next server startup instead. Runs
      // before release() only because that is the natural order of this
      // block; both are inside the same finally, which is the load-bearing
      // property.
      try {
        if (completed) await billable?.after();
      } finally {
        pool.release(ctx.project.id);
      }
    }
  };
}
