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
import type { ApiKeyProvider } from "./api-keys.ts";
import {
  API_KEY_PROVIDERS,
  DEFAULT_API_KEY_PROVIDER,
  fingerprintOf,
  getApiKeyPlaintext,
  isApiKeyProvider,
  providerOfKeyShape,
} from "./api-keys.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";
import { findUserById } from "./users.ts";

/**
 * Which environment variable carries which provider's key, and the variable
 * that selects the provider.
 *
 * A LOOKUP TABLE over a validated union, never a name built by string
 * interpolation from the stored value. This repo has shipped four separate
 * defects from a client- or model-influenced string reaching a path, a URL or a
 * spawn argument; an environment-variable NAME is the same hazard wearing
 * different clothes, and a table makes the set of names it can produce closed.
 *
 * `ORCH_MODEL_PROVIDER` is the orchestrator's own existing opt-in escape hatch
 * (`orchestrator/src/orchestrator/config.py`, `model_call.py`), not something
 * invented here: `gemini` swaps the tier table and reads `GEMINI_API_KEY`,
 * anything else keeps Anthropic.
 */
export const PROVIDER_KEY_ENV_VAR: Readonly<Record<ApiKeyProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export const MODEL_PROVIDER_ENV_VAR = "ORCH_MODEL_PROVIDER";

/** Typed so a route can map it to a 400 with an actionable message. */
export class MissingApiKeyError extends Error {
  constructor() {
    super("no model-provider API key: save one in settings, or supply one with this request");
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

/** A usable credential: the key, and the provider it must be sent to. */
export interface ResolvedApiKey {
  apiKey: string;
  provider: ApiKeyProvider;
}

/**
 * A pasted key wins over the stored one: storing is a convenience, not a
 * requirement (spec, BYOK requirement 4). But a disabled account gets
 * neither — checked first, and before the pasted-key short circuit, so a
 * disabled user cannot spend anything through this system, whoever's key it
 * is.
 *
 * A PASTED key has no stored provider to read, so its provider is inferred
 * from its own shape — the only source of truth available for a value that was
 * never stored. That inference is sound precisely because `setApiKey` refuses a
 * key whose shape disagrees with its declared provider: shape and provider
 * cannot diverge for a key this system would accept. An unrecognised shape
 * falls back to the default provider, which preserves this path's pre-existing
 * behaviour exactly (it used to hand every pasted value to Anthropic).
 */
export function resolveApiKey(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  pastedKey?: string,
): ResolvedApiKey {
  const user = findUserById(db, userId);
  // Two distinct failures, kept distinct: an operator debugging a bad
  // owner_id in slice 4 must not be told "this account is disabled" when
  // there is no row at all. Both fail closed; only the message differs.
  if (user === null) throw new UnknownUserError();
  if (user.disabledAt !== null) throw new DisabledUserError();
  if (pastedKey !== undefined && pastedKey !== "") {
    return {
      apiKey: pastedKey,
      provider: providerOfKeyShape(pastedKey) ?? DEFAULT_API_KEY_PROVIDER,
    };
  }
  const stored = getApiKeyPlaintext(db, masterKey, userId);
  if (stored === null || stored.apiKey === "") throw new MissingApiKeyError();
  return stored;
}

/**
 * A copy of the environment with everything a child must never inherit
 * removed. Three kinds of deletion, for three different reasons:
 *
 * - The master key decrypts every user's stored API key. A preview child runs
 *   the project's own vite.config.ts — unowned scaffold copied verbatim, not
 *   generated by any agent, but never validated either — so anything in its
 *   environment is reachable by code nobody has reviewed.
 * - The HOST's key, for EVERY provider — `ANTHROPIC_API_KEY` and
 *   `GEMINI_API_KEY` both. This one is easy to miss because it looks like a
 *   harmless default: if a user has no stored key and the child inherits the
 *   operator's, generation still works — and the operator pays, for a user the
 *   spend cap will happily record as having spent nothing they were billed for.
 *   Absent is correct; inherited is a silent transfer. Adding a provider
 *   without adding its variable here re-opens that hole for the new provider
 *   only, which is why this iterates `PROVIDER_KEY_ENV_VAR` rather than listing
 *   names: a new provider cannot be added to the table without also being
 *   scrubbed.
 * - `ORCH_MODEL_PROVIDER`, which is not a credential but SELECTS one. Left
 *   inherited, an operator's own `ORCH_MODEL_PROVIDER=gemini` (in the shell, or
 *   in `orchestrator/.env`, which python-dotenv loads with `override=False` and
 *   so fills in whenever the variable is absent) would redirect an
 *   Anthropic-key user's run onto the Gemini path — where, the injected key
 *   having been deleted, the orchestrator would fall back to the OPERATOR's
 *   `GEMINI_API_KEY` from that same file. `buildAgentEnv` sets this explicitly
 *   for both providers, so the user's stored choice is the only thing that
 *   decides, and no host value can vote.
 *
 * A copy, never a mutation of process.env, which would leak into every later
 * spawn in this process.
 */
export function scrubbedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env[MASTER_KEY_ENV_VAR];
  for (const provider of API_KEY_PROVIDERS) delete env[PROVIDER_KEY_ENV_VAR[provider]];
  delete env[MODEL_PROVIDER_ENV_VAR];
  return env;
}

/**
 * The (provider, fingerprint) pair an environment ACTUALLY carries, or null
 * when it carries no key at all.
 *
 * Derived from the env rather than from a second database read, so a caller
 * recording what a child was spawned with cannot disagree with what the child
 * was actually given. Never returns, logs or stores the key itself — only its
 * last four characters (`fingerprintOf`).
 *
 * Reads `MODEL_PROVIDER_ENV_VAR` as the selector rather than guessing from
 * whichever variable happens to be set, because that variable is what the
 * orchestrator itself dispatches on: this answers "what will the child do",
 * not "what could it do".
 */
export function injectedCredential(
  env: NodeJS.ProcessEnv,
): { provider: ApiKeyProvider; fingerprint: string } | null {
  const declared = env[MODEL_PROVIDER_ENV_VAR];
  const provider = isApiKeyProvider(declared) ? declared : DEFAULT_API_KEY_PROVIDER;
  const apiKey = env[PROVIDER_KEY_ENV_VAR[provider]];
  if (apiKey === undefined || apiKey === "") return null;
  return { provider, fingerprint: fingerprintOf(apiKey) };
}

/**
 * The child gets exactly one provider's key, and is told which provider that
 * is. Both halves matter: the key alone would be read as an Anthropic key by
 * default, and the selector alone would send the run to a provider whose key
 * `scrubbedEnv` just deleted.
 */
export function buildAgentEnv(args: {
  db: DatabaseSync;
  masterKey: Buffer;
  userId: string;
  pastedKey?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const { db, masterKey, userId, pastedKey, baseEnv = process.env } = args;
  const { apiKey, provider } = resolveApiKey(db, masterKey, userId, pastedKey);
  const env = scrubbedEnv(baseEnv);
  // Last assignment wins deliberately: the host's own keys were just removed
  // by scrubbedEnv, and the request's user pays for the request. The variable
  // NAME comes from a fixed table keyed by a validated union — never built by
  // interpolating the stored value.
  env[PROVIDER_KEY_ENV_VAR[provider]] = apiKey;
  // Set for anthropic too, not only for gemini: an unset variable would let
  // orchestrator/.env decide, which is exactly what scrubbedEnv's deletion of
  // it exists to prevent.
  env[MODEL_PROVIDER_ENV_VAR] = provider;
  return env;
}
