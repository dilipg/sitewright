// server/src/agent-env.ts
/**
 * Where a user's plaintext key is read and handed to a child process.
 *
 * The orchestrator reads ANTHROPIC_API_KEY from its environment (today from
 * orchestrator/.env in the local flow). Under the hosted server the key is
 * injected per invocation, for one user's request only (spec, BYOK
 * requirement 5) — never written to a file, never put in process.env.
 *
 * Two rules this file exists to enforce:
 *   - the master key does NOT travel to the child; a child holding it could
 *     decrypt every user's credential, so one escape would be total.
 *   - no error raised here contains a key. Callers log these.
 */
import type { DatabaseSync } from "node:sqlite";
import { getApiKeyPlaintext } from "./api-keys.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";
import { findUserById } from "./users.ts";

/** Typed so a route can map it to a 400 with an actionable message. */
export class MissingApiKeyError extends Error {
  constructor() {
    super("no Anthropic API key: save one in settings, or supply one with this request");
    this.name = "MissingApiKeyError";
  }
}

/**
 * Typed so a caller (a live route today; a project's owner_id lookup once
 * slice 4 lands) can map it to a 4xx rather than spending a disabled
 * account's key. `disable` revokes sessions, which closes the HTTP surface —
 * but that is not the same guarantee as this: slice 4 resolves keys from a
 * project's owner_id, not from a live session, so an offboarded or
 * suspected-compromised user's key must be refused here too, or `disable`
 * alone is not enough to stop it being spent.
 */
/**
 * Distinct from DisabledUserError on purpose. Both fail closed, but they mean
 * different things to whoever is reading the error: "disabled" is a decision
 * someone made, "unknown" is a bad id — and slice 4 resolves keys from a
 * project's owner_id, which is exactly where a bad id shows up.
 */
export class UnknownUserError extends Error {
  constructor() {
    super("no such user: no key can be resolved");
    this.name = "UnknownUserError";
  }
}

export class DisabledUserError extends Error {
  constructor() {
    super("this account is disabled: no key can be resolved for it, pasted or stored");
    this.name = "DisabledUserError";
  }
}

/**
 * A pasted key wins over the stored one: storing is a convenience, not a
 * requirement (spec, BYOK requirement 4). But a disabled account gets
 * neither — checked first, and before the pasted-key short circuit, so a
 * disabled user cannot spend anything through this system, whoever's key it
 * is.
 */
export function resolveApiKey(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  pastedKey?: string,
): string {
  const user = findUserById(db, userId);
  // Two distinct failures, kept distinct: an operator debugging a bad
  // owner_id in slice 4 must not be told "this account is disabled" when
  // there is no row at all. Both fail closed; only the message differs.
  if (user === null) throw new UnknownUserError();
  if (user.disabledAt !== null) throw new DisabledUserError();
  if (pastedKey !== undefined && pastedKey !== "") return pastedKey;
  const stored = getApiKeyPlaintext(db, masterKey, userId);
  if (stored === null || stored === "") throw new MissingApiKeyError();
  return stored;
}

export function buildAgentEnv(args: {
  db: DatabaseSync;
  masterKey: Buffer;
  userId: string;
  pastedKey?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const { db, masterKey, userId, pastedKey, baseEnv = process.env } = args;
  const apiKey = resolveApiKey(db, masterKey, userId, pastedKey);
  // A COPY. Mutating process.env would leak this user's key into every later
  // subprocess and into any diagnostic dump.
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env[MASTER_KEY_ENV_VAR];
  // Last assignment wins deliberately: the host's own key may be inherited,
  // but under the hosted server the request's user pays for the request.
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}
