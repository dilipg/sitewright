// server/src/preview-routes.ts
/**
 * Mounts the preview pool + proxy behind the ownership check: one route,
 * `GET /preview/:projectId/*`, that turns an authorized request into bytes
 * proxied from that project's own Vite dev server (`preview-pool.ts` spawns
 * and reuses the child; `preview-proxy.ts` shuffles the bytes; this file is
 * only the wiring between them and `requireProject`).
 *
 * Authorization runs BEFORE the pool is ever touched. `requireProject` (which
 * itself composes `requireSession`) resolves the session and checks
 * ownership before this handler's body executes at all — an unauthenticated
 * or non-owner request never reaches `pool.acquire`. That ordering is not
 * incidental: `acquire` can spawn a real subprocess, so authorizing after the
 * fact would let a bad request spend a spawn — a denial-of-service surface,
 * not merely an information leak.
 *
 * `retain`/`release` bracket the proxy call, with `release` in a `finally`:
 * a client that disconnects mid-request — or a proxy call that somehow
 * throws — must still free the slot, or one aborted request pins the preview
 * forever and `MAX_PREVIEWS` leaks down over the life of the process.
 *
 * The forwarded path is the request's ORIGINAL, UNMODIFIED `req.url` —
 * `/preview/<projectId>/...` prefix and all — not the wildcard tail
 * (`ctx.params["*"]`) with that prefix stripped off. This was gotten wrong
 * once already and only a real Vite child behind a real proxy could show it
 * (task 4's manual Step 5, see the report): `preview-pool.ts` spawns each
 * child with `--base /preview/<projectId>/`, and Vite's dev server, given a
 * non-root `base`, expects every request to arrive WITH that base prefix
 * still attached — it uses the prefix both to generate correct asset URLs in
 * the HTML it serves and to route the incoming request internally. A
 * stripped request (bare "/") gets a 302 back to the very prefix that was
 * just removed; proxying that redirect through unexamined is an infinite
 * loop from the client's perspective, since the "corrected" URL is the exact
 * one it started with. `ctx.params["*"]` still exists (the router match
 * needs the wildcard to accept every path under the project's prefix at
 * all), it just is not used to build the forwarded path.
 */
import type { DatabaseSync } from "node:sqlite";
import { PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { proxyHttp } from "./preview-proxy.ts";
import { requireProject } from "./require-project.ts";
import { sendJson, type Route } from "./router.ts";

export function previewRoutes(deps: { db: DatabaseSync; pool: PreviewPool }): Route[] {
  const { db, pool } = deps;
  return [
    {
      method: "GET",
      path: "/preview/:projectId/*",
      handler: requireProject(db, { from: "param", name: "projectId" }, async (req, res, ctx) => {
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
          // req.url, unmodified — see the module comment for why stripping
          // the project-id prefix here would loop the client against Vite's
          // own base-redirect forever.
          await proxyHttp({ req, res, port: preview.port, path: req.url ?? "/" });
        } finally {
          pool.release(ctx.project.id);
        }
      }),
    },
  ];
}
