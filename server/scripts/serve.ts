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
import { authRoutes } from "../src/auth-routes.ts";
import { openDatabase } from "../src/db.ts";
import { createRequestListener } from "../src/router.ts";
import { deleteExpiredSessions } from "../src/sessions.ts";
// Reuses the flag() already fixed twice (server/src/user-cli.ts, applied to
// scripts/user.ts in commit 72dd44b) rather than keeping this script's own
// independent copy of the same swallowed-value defect: one implementation,
// one place left to fix.
import { flag } from "../src/user-cli.ts";

// Defence in depth, not the fix itself (that is router.ts's URL-construction
// guard): node:http installs no handler for a rejected request-listener
// promise or an exception outside one, so without this, the *next* such bug
// still takes the whole process down for every user until a human restarts
// it. Log and keep serving rather than exit.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (server continues):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("uncaught exception (server continues):", error);
});

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

const db = openDatabase(dbPath);
const pruned = deleteExpiredSessions(db);
if (pruned > 0) console.log(`pruned ${pruned} expired session(s)`);

createServer(createRequestListener(authRoutes({ db, secureCookies }))).listen(port, () => {
  console.log(`server listening on http://localhost:${port} (db: ${dbPath})`);
  if (!secureCookies) console.log("INSECURE_COOKIES=1 — Secure flag omitted; local development only");
});
