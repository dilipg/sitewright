/**
 * Operator CLI wrapper. Usage:
 *   node scripts/user.ts create --email you@example.com
 *   node scripts/user.ts disable --email you@example.com
 *   node scripts/user.ts reset-password --email you@example.com
 *   node scripts/user.ts set-cap --email you@example.com --usd 50
 *   node scripts/user.ts list
 */
import { openDatabase } from "../src/db.ts";
import { flag, runUserCommand } from "../src/user-cli.ts";

const argv = process.argv.slice(2);
// Reuses user-cli's flag() so a swallowed flag name (e.g. `--db --email a@b.c`)
// is treated as no value, not as the literal db path, same as every other flag.
//
// `--db` with nothing after it must FAIL rather than fall back to the default,
// for the reason `serve.ts`'s own `requireValueIfPresent` gives: an operator who
// typed `--db` meant to specify one. It applies at least as strongly here,
// because this is the script that CREATES ACCOUNTS: the silent fallback put the
// account in `./data/identity.db` relative to CWD while the server read another
// file, and the only symptom was the deliberately uniform
// `invalid email or password` — which reveals nothing about two databases
// existing. Found by following the README literally from a clean shell (task 6).
if (argv.includes("--db") && flag(argv, "db") === undefined) {
  console.error("--db requires a value");
  process.exit(1);
}
const dbPath = flag(argv, "db") ?? "./data/identity.db";

try {
  console.log(await runUserCommand(openDatabase(dbPath), argv));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
