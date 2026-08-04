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
import { buildRoutes } from "../src/compose.ts";
import { openDatabase } from "../src/db.ts";
import { loadMasterKey, MASTER_KEY_ENV_VAR } from "../src/master-key.ts";
import { createRequestListener } from "../src/router.ts";
import { deleteExpiredSessions } from "../src/sessions.ts";
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

const server = createServer(
  createRequestListener(buildRoutes({ db, masterKey, secureCookies })),
);

// A failure to bind (EADDRINUSE, EACCES on a privileged port) is a failed boot,
// not a runtime hiccup: exit non-zero so a supervisor restarts and a deploy
// chain sees it. Without this, `listen` emits 'error' with no listener and the
// process dies on an unhandled 'error' event instead of saying why.
server.on("error", (error) => {
  console.error(`could not listen on port ${port}:`, error);
  process.exit(1);
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
