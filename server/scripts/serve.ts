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
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
}

const port = Number(flag("port", "4000"));
const dbPath = flag("db", "./data/identity.db");
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
