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
const dbPath = flag(argv, "db") ?? "./data/identity.db";

try {
  console.log(await runUserCommand(openDatabase(dbPath), argv));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
