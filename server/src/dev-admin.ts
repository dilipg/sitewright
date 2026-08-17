/**
 * Seeds a local `admin` / `admin` account on a genuinely empty database, so a
 * friends-and-family tester can start the stack and log in without first
 * running an operator CLI command.
 *
 * THIS IS A SHIPPED DEFAULT CREDENTIAL, which is normally indefensible. What
 * makes it acceptable here is a specific and narrow set of conditions, and if
 * ANY of them stops holding this must be deleted rather than adjusted:
 *
 *   1. Every tester runs their OWN instance, on their own machine, against
 *      their own API key. There is no shared host and no shared data.
 *   2. The server binds LOOPBACK ONLY, so the account is not reachable from the
 *      tester's network. `serve.ts` now passes an explicit host for this
 *      reason — it previously passed none, which binds every interface, and
 *      `compose.yaml`'s own comment already said why that is wrong ("a
 *      single-user local tool with a session cookie carrying no Secure flag").
 *      Docker hid it behind a `127.0.0.1:` port mapping; running from source
 *      did not.
 *   3. It happens once, on an EMPTY user table. It cannot resurrect a deleted
 *      account, cannot overwrite an existing one, and cannot re-seed after an
 *      operator disables it.
 *
 * WHY THIS IS NOT A VIOLATION OF THE OWNERSHIP RULE. `CLAUDE.md` states that no
 * HTTP *route* may create a user, which is what makes invite-only structural.
 * This runs in the composition root at boot — the same place, and with the same
 * authority, as `user-cli.ts` — and no request can reach it. The rule is
 * intact; what changes is that a fresh local install now has one account
 * already in it.
 *
 * IT MUST NEVER SURVIVE A MOVE TO A SHARED HOST. The moment a second person can
 * reach one instance, a published credential stops being a convenience and
 * becomes an open door to someone else's API key. `docs/pending.md`'s D1/D2/D3
 * are the items that mark that transition.
 */
import type { DatabaseSync } from "node:sqlite";

import { hashPassword } from "./passwords.ts";
import { createUser, listUsers, setSpendCap } from "./users.ts";

/** Deliberately not an email address. `looksLikeEmail` is enforced only in
 *  `user-cli.ts`; `createUser` and `auth-routes.ts`'s `findUserByEmail` both
 *  take a plain string, so the literal word the tester is told to type is what
 *  gets stored. */
export const DEV_ADMIN_EMAIL = "admin";
export const DEV_ADMIN_PASSWORD = "admin";

/** Set to anything non-empty to refuse the seed outright. */
export const DEV_ADMIN_DISABLE_ENV_VAR = "WEBGEN_NO_DEV_ADMIN";

/** A modest cap on the seeded account: a default credential should not also
 *  carry a large default spending authority. An operator raises it with
 *  `user.ts set-cap --usd`. */
export const DEV_ADMIN_SPEND_CAP_USD = 10;

export type DevAdminOutcome =
  | "seeded"
  | "skipped-disabled"
  | "skipped-not-loopback"
  | "skipped-users-exist";

/** Hosts from which only this machine can connect. `::1` and its
 *  IPv4-mapped form included because Node resolves `localhost` to either. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export interface SeedDevAdminOptions {
  /** The interface `serve.ts` is about to bind. Seeding is refused for
   *  anything else — see this module's own comment, condition 2. */
  readonly host: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to `console.log`. */
  readonly log?: (message: string) => void;
}

/**
 * Creates the local admin account, or explains why it did not.
 *
 * Returns rather than throws: a refusal is a normal, expected outcome (an
 * operator who set the off switch, a database that already has users), and a
 * boot that dies over a convenience feature would be a worse trade than one
 * that starts without it.
 */
export async function seedDevAdmin(
  db: DatabaseSync,
  options: SeedDevAdminOptions,
): Promise<DevAdminOutcome> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));

  if ((env[DEV_ADMIN_DISABLE_ENV_VAR] ?? "").trim() !== "") {
    return "skipped-disabled";
  }

  // Checked BEFORE the empty-table check, so the log line a non-loopback
  // operator sees names the reason that actually matters to them.
  if (!isLoopbackHost(options.host)) {
    log(
      `refusing to seed the default ${DEV_ADMIN_EMAIL} account: the server is bound to ` +
        `${options.host}, which is reachable beyond this machine. Create an account with ` +
        `\`node server/scripts/user.ts create --email you@example.com --db <path>\` instead.`,
    );
    return "skipped-not-loopback";
  }

  // The whole table, not "does `admin` exist": an operator who deleted the
  // seeded account, or who created their own account and never wanted this
  // one, must not have it reappear at the next boot.
  if (listUsers(db).length > 0) {
    return "skipped-users-exist";
  }

  const user = createUser(db, DEV_ADMIN_EMAIL, await hashPassword(DEV_ADMIN_PASSWORD));
  setSpendCap(db, user.id, DEV_ADMIN_SPEND_CAP_USD);

  log(
    `\n  created the default local account — sign in with ${DEV_ADMIN_EMAIL} / ${DEV_ADMIN_PASSWORD}` +
      `\n  This is a KNOWN password and exists only because this server is bound to ` +
      `${options.host}. Change it with \`node server/scripts/user.ts reset-password --email ` +
      `${DEV_ADMIN_EMAIL} --db <path>\`, or set ${DEV_ADMIN_DISABLE_ENV_VAR}=1 to skip this ` +
      `entirely and create your own account.\n`,
  );
  return "seeded";
}
