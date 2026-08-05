// server/scripts/serve.ts
/**
 * The hosted composition root.
 *
 * It exists alongside `compiler/scripts/preview.ts`, which stays exactly as it
 * is: unauthenticated, local, and the target of all 636 existing tests. Auth is
 * added by composing a different root, never by editing a handler.
 *
 * Usage: node scripts/serve.ts [--port 4000] [--db ./data/identity.db]
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { adoptExistingProjects } from "../src/adopt.ts";
import { buildRoutes } from "../src/compose.ts";
import { openDatabase } from "../src/db.ts";
import { loadMasterKey, MASTER_KEY_ENV_VAR } from "../src/master-key.ts";
import { PreviewPool } from "../src/preview-pool.ts";
import { proxyUpgrade } from "../src/preview-proxy.ts";
import { findProjectById } from "../src/projects.ts";
import { createRequestListener, parseCookies } from "../src/router.ts";
import { deleteExpiredSessions, resolveSession, SESSION_COOKIE } from "../src/sessions.ts";
import { findUserByEmail } from "../src/users.ts";
// Reuses the flag() already fixed twice (server/src/user-cli.ts, applied to
// scripts/user.ts in commit 72dd44b) rather than keeping this script's own
// independent copy of the same swallowed-value defect: one implementation,
// one place left to fix.
import { flag } from "../src/user-cli.ts";

const args = process.argv.slice(2);

/**
 * flag() alone can't distinguish "not passed" from "passed with no value" —
 * both return undefined (the latter because a following `--other-flag` is
 * treated as no value, not a value that happens to look like a flag). For an
 * operator-facing script that ambiguity is exactly the bug: `--db` with
 * nothing after it must fail loudly, not silently fall back to the default
 * database, because an operator who typed `--db` meant to specify one.
 */
function requireValueIfPresent(name: string): string | undefined {
  if (!args.includes(`--${name}`)) return undefined;
  const value = flag(args, name);
  if (value === undefined) {
    console.error(`--${name} requires a value`);
    process.exit(1);
  }
  return value;
}

const dbPath = requireValueIfPresent("db") ?? "./data/identity.db";
// Resolved against CWD, and CWD for the documented invocation (`npm run
// serve -w server`, per npm workspaces) is server/ — so "./generated" would
// point at server/generated, which does not exist; the repo's real projects
// root (worth hundreds of MB of acceptance runs, per the spec's Operational
// requirement) is one level up, at the repo root's generated/.
const projectsRoot = requireValueIfPresent("projects-root") ?? "../generated";
const bootstrapEmail = requireValueIfPresent("bootstrap-email");

const portRaw = requireValueIfPresent("port") ?? "4000";
const port = Number(portRaw);
// Number("--foo") and Number("") are both NaN; a bad --port used to reach
// .listen() as NaN and surface as a raw RangeError stack trace instead of an
// operator-legible message.
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`--port must be an integer between 1 and 65535; got ${JSON.stringify(portRaw)}`);
  process.exit(1);
}

// Off only for local HTTP. In production the reverse proxy terminates TLS, so
// this must be 1 — a session cookie without Secure can leak over plain HTTP.
const secureCookies = process.env.INSECURE_COOKIES !== "1";

// Before anything else that could fail for a mundane reason: an operator who
// forgot the master key should learn it immediately, not after a port bind.
const masterKey = loadMasterKey();
// The Buffer above is now the single in-memory copy of the master key for
// this process — leaving WEBGEN_MASTER_KEY in process.env would hand it to
// every child process this server spawns WITHOUT an explicit `env` override.
// Today that is the generated project's own `npm run build`
// (compiler/src/exporter.ts), its `tsc --noEmit` (compiler/src/gates.ts), and
// the orchestrator's regeneration subprocess (compiler/src/regen-api.ts) —
// none of them opt into a scrubbed copy the way buildAgentEnv's own copy
// does; they inherit process.env verbatim. Export runs the generated
// project's own config and plugin chain, which is model-generated from a
// free-text brief, i.e. untrusted input. One process.env read there would
// decrypt every user's stored key.
delete process.env[MASTER_KEY_ENV_VAR];

const db = openDatabase(dbPath);
const pruned = deleteExpiredSessions(db);
if (pruned > 0) console.log(`pruned ${pruned} expired session(s)`);

// Adoption runs on EVERY boot (idempotent by construction — see adopt.ts) so
// that acceptance runs already on disk get an owner instead of being orphaned.
// It must never create a user itself: only server/src/user-cli.ts may do that,
// so an unresolved --bootstrap-email is a skip, not a fallback account.
if (bootstrapEmail !== undefined) {
  const owner = findUserByEmail(db, bootstrapEmail);
  if (owner === null) {
    console.warn(
      `--bootstrap-email ${bootstrapEmail} does not match any existing user; skipping project adoption`,
    );
  } else {
    const { adopted, skipped, rootReadable } = adoptExistingProjects(db, projectsRoot, owner.id);
    if (!rootReadable) {
      // Distinct from the success line below on purpose: "0 adopted, 0
      // already known" reads as a success for a root that turned out to be
      // missing, unreadable, or not a directory (ENOENT/EACCES/ENOTDIR, all
      // swallowed the same way by adoptExistingProjects) — exactly the
      // no-op an operator who mistyped --projects-root would never notice.
      // The resolved absolute path is named so an operator can see where
      // this process actually looked, since a relative default resolves
      // against CWD, which differs by how the process was launched.
      console.warn(
        `project adoption: could not read projects root ${resolve(projectsRoot)} `
        + "(missing, inaccessible, or not a directory) — 0 adopted",
      );
    } else {
      console.log(
        `project adoption: ${adopted.length} adopted, ${skipped.length} already known (owner: ${bootstrapEmail})`,
      );
    }
  }
}

// Constructed after the database is open, from the master key already in
// hand (the Buffer, not process.env — that copy was deleted above). Every
// child this pool spawns runs a project's own model-generated
// vite.config.ts, so it gets a deliberately narrowed environment; see
// preview-pool.ts's own module comment for the properties that enforces.
const pool = new PreviewPool({ db, masterKey, projectsRoot });

// A truly idle preview gets killed and forgotten so MAX_PREVIEWS reflects
// real usage, not history. Interval itself is unref()'d — it must never be
// the reason this process stays alive — which is unrelated to (and does not
// weaken) the pool's own rule that a live CHILD PROCESS is never unref()'d.
const REAP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const killed = pool.reapIdle();
  if (killed.length > 0) {
    console.log(`reaped ${killed.length} idle preview process(es): ${killed.join(", ")}`);
  }
}, REAP_INTERVAL_MS).unref();

// Every child must die with the server: an orphaned Vite process holding a
// port open past this process's own lifetime is exactly the failure
// preview-pool.ts exists to bound. `shuttingDown` makes this idempotent —
// some shells deliver both SIGINT and SIGTERM for one Ctrl-C, and a second
// signal arriving mid-shutdown must not race a second pool.shutdown() against
// the first.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, killing preview processes...`);
  pool.shutdown()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("error while shutting down preview processes:", error);
      process.exit(1);
    });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const server = createServer(
  createRequestListener(buildRoutes({ db, masterKey, secureCookies, pool })),
);

// A failure to bind (EADDRINUSE, EACCES on a privileged port) is a failed boot,
// not a runtime hiccup: exit non-zero so a supervisor restarts and a deploy
// chain sees it. Without this, `listen` emits 'error' with no listener and the
// process dies on an unhandled 'error' event instead of saying why.
server.on("error", (error) => {
  console.error(`could not listen on port ${port}:`, error);
  process.exit(1);
});

/**
 * A WebSocket upgrade (Vite's HMR client) never reaches the route table:
 * node:http fires 'upgrade' for it, never 'request', so
 * createRequestListener — and with it, requireProject/requireSession — never
 * runs. That makes this the ONE authorization path outside the table, and
 * therefore the one that has to be re-derived BY HAND rather than trusted
 * because "the table is the allowlist" covers everything else. It carries the
 * same session cookie an ordinary request does; skipping this check and
 * proxying straight through would be an ownership hole no route-table test
 * could ever see, because an upgrade never touches that table at all.
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
 * project id segment is decoded here, and only to look the project up —
 * the path handed to `proxyUpgrade` is the original bytes.
 */
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => { /* see preview-proxy.ts's module comment: an unlistened 'error' event throws and can crash the process */ });
  void (async () => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    // "/preview/<projectId>/..." parsed by hand — the router's own wildcard
    // matcher is not reachable from here (see the comment above). Only the
    // project id segment is extracted; the rest of the path is never
    // inspected or reconstructed, since it is forwarded verbatim below.
    const segments = url.pathname.split("/");
    if (segments.length < 3 || segments[1] !== "preview" || segments[2] === "") {
      socket.destroy();
      return;
    }
    let projectId: string;
    try {
      projectId = decodeURIComponent(segments[2]!);
    } catch {
      // A malformed percent-escape is a malformed path — refuse it, the same
      // answer router.ts's matcher gives a request with one.
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
    // Same one-message-for-both-failures shape require-project.ts uses, for
    // the same reason: a raw socket destroy carries no message at all, so
    // there is nothing here that could distinguish the two even accidentally.
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
    // Every fallible step above is already guarded, but node:http installs no
    // handler for a rejected 'upgrade' listener any more than it does for a
    // rejected request listener (see router.ts) — this is defence in depth,
    // not the primary fix, against a future change inside the block above
    // forgetting its own guard.
    try { socket.destroy(); } catch { /* already gone */ }
  });
});

server.listen(port, () => {
  console.log(`server listening on http://localhost:${port} (db: ${dbPath})`);
  if (!secureCookies) console.log("INSECURE_COOKIES=1 — Secure flag omitted; local development only");

  // Registered only once the server is genuinely up, and deliberately NOT at
  // module top level. Above this point these handlers would swallow every
  // startup failure — an unopenable --db, a port already in use — and turn a
  // failed boot into a silent exit 0 that logs "server continues" while
  // serving nothing. A supervisor reads exit 0 as "do not restart".
  //
  // Past this point the trade flips. node:http installs no handler for a
  // rejected request-listener promise or an exception thrown outside one, so
  // without these the *next* such bug takes the whole process down for every
  // user until a human restarts it. This is defence in depth, not the fix
  // itself — that is router.ts's URL-construction guard.
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection (server continues):", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaught exception (server continues):", error);
  });
});
