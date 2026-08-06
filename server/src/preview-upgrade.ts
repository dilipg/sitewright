// server/src/preview-upgrade.ts
/**
 * The WebSocket upgrade handler (Vite's HMR client) — extracted out of
 * `scripts/serve.ts` so it is testable at all. `scripts/serve.ts` itself
 * cannot be imported for a unit test (its module body has side effects the
 * instant it runs: it parses `process.argv`, may `process.exit`, opens a
 * real database, binds a real port — see `compose.test.ts`'s own comment on
 * exactly this), which is precisely why this handler had ZERO tests before
 * this file existed, despite being — in its own words — "the ONE
 * authorization path outside the route table."
 *
 * A WebSocket upgrade never reaches the route table: node:http fires
 * 'upgrade' for it, never 'request', so `createRequestListener` — and with
 * it, `requireProject`/`requireSession` — never runs. That makes this the
 * ONE authorization path that has to be re-derived BY HAND rather than
 * trusted because "the table is the allowlist" covers everything else. It
 * carries the same session cookie an ordinary request does; skipping this
 * check and proxying straight through would be an ownership hole no
 * route-table test could ever see, because an upgrade never touches that
 * table at all. Deleting the `project.ownerId !== user.id` comparison below
 * turns HMR into an unauthenticated cross-tenant socket with every OTHER
 * test in this codebase still green — which is exactly why this file's own
 * tests exist.
 *
 * `pool.acquire` (not a plain lookup) deliberately: in the normal flow the
 * page's own GET request already spawned the preview before the browser's
 * Vite client ever opens this socket, so this almost always reuses that
 * entry — but treating the upgrade as capable of spawning its own, exactly
 * like the GET route does, means a client that somehow opens the socket
 * first still gets a correctly-authorized preview instead of a confusing
 * refusal.
 *
 * The forwarded path is `req.url` UNMODIFIED, `/preview/<projectId>` prefix
 * and all — never a stripped tail. See preview-routes.ts's module comment
 * for why: the child's Vite dev server is spawned with a matching `--base`
 * and expects requests to arrive WITH that prefix, not without it. Only the
 * project id segment is decoded here, and only to look the project up — the
 * path handed to `proxyUpgrade` is the original bytes, QUERY STRING
 * included: Vite's HMR handshake carries its own token
 * (`?token=<...>`), and a version of this that reconstructed the path from
 * decoded segments would silently drop it.
 *
 * Deliberately ASYMMETRIC with `preview-routes.ts` in one respect: that
 * handler brackets its `proxyHttp` call in `pool.retain()`/`pool.release()`
 * so the reaper cannot kill the subprocess mid-request. This handler does
 * neither, and that omission is intentional, not a mirror this file forgot —
 * an HMR socket is meant to sit open and idle for long stretches between
 * events by design (see `proxyUpgrade`'s own "no timeout on this path"
 * comment); `retain()`-ing it for the socket's entire lifetime would mean one
 * open browser tab pins its project's preview alive forever, defeating
 * `idleMs` for every project with a tab left open. The consequence is worth
 * stating plainly rather than leaving implicit: an open HMR socket does NOT
 * count as "use" against the pool's idle clock, so once `idleMs` elapses the
 * underlying child CAN be reaped out from under a still-open socket. When
 * that happens, Vite's own HMR client notices the dropped connection and
 * retries — but nothing on this path respawns the child for it; the project
 * stays down until the next ordinary HTTP request (`preview-routes.ts`)
 * calls `pool.acquire()` again.
 */
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import type { PreviewPool } from "./preview-pool.ts";
import { proxyUpgrade } from "./preview-proxy.ts";
import { findProjectById } from "./projects.ts";
import { parseCookies } from "./router.ts";
import { resolveSession, SESSION_COOKIE } from "./sessions.ts";

export type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export function createPreviewUpgradeListener(deps: { db: DatabaseSync; pool: PreviewPool }): UpgradeListener {
  const { db, pool } = deps;

  return (req, socket, head) => {
    // See preview-proxy.ts's module comment: an unlistened 'error' event on
    // an EventEmitter throws synchronously and can crash the whole process,
    // not just this one connection.
    socket.on("error", () => { /* nothing to clean up beyond the destroy() calls below */ });

    void (async () => {
      // The route table's own entry for this path (preview-routes.ts) is
      // `method: "GET"`, but an upgrade never reaches that table (see above)
      // — node:http fires 'upgrade' for ANY method carrying Connection:
      // Upgrade + Upgrade headers, not only GET, so that constraint has to
      // be re-derived here too, by hand, exactly like the ownership check
      // above. Refusing anything else costs nothing (a WebSocket handshake
      // per RFC 6455 is always a GET) and closes the one path where this
      // listener's own work — a session lookup, a `pool.acquire()` that can
      // spawn a real subprocess — would run for a request shape Vite's own
      // handshake code would refuse anyway.
      if (req.method !== "GET") {
        socket.destroy();
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      } catch {
        socket.destroy();
        return;
      }
      // "/preview/<projectId>/..." parsed by hand — the router's own
      // wildcard matcher is not reachable from here (see the module
      // comment). Only the project id segment is extracted; the rest of the
      // path is never inspected or reconstructed, since it is forwarded
      // verbatim below.
      const segments = url.pathname.split("/");
      if (segments.length < 3 || segments[1] !== "preview" || segments[2] === "") {
        socket.destroy();
        return;
      }
      let projectId: string;
      try {
        projectId = decodeURIComponent(segments[2]!);
      } catch {
        // A malformed percent-escape is a malformed path — refuse it, the
        // same answer router.ts's matcher gives a request with one.
        socket.destroy();
        return;
      }

      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = sid === undefined ? null : resolveSession(db, sid);
      if (user === null) {
        socket.destroy();
        return;
      }
      const project = findProjectById(db, projectId);
      // Same one-message-for-both-failures shape require-project.ts uses,
      // for the same reason: a raw socket destroy carries no message at
      // all, so there is nothing here that could distinguish the two even
      // accidentally.
      if (project === null || project.ownerId !== user.id) {
        socket.destroy();
        return;
      }

      let preview: { port: number };
      try {
        preview = await pool.acquire(project, user.id);
      } catch {
        socket.destroy();
        return;
      }
      proxyUpgrade({ req, socket, head, port: preview.port, path: req.url ?? "/" });
    })().catch(() => {
      // Every fallible step above is already guarded, but node:http installs
      // no handler for a rejected 'upgrade' listener any more than it does
      // for a rejected request listener (see router.ts) — this is defence
      // in depth, not the primary fix, against a future change inside the
      // block above forgetting its own guard.
      try { socket.destroy(); } catch { /* already gone */ }
    });
  };
}
