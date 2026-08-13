/**
 * One model-provider API key per user, encrypted at rest.
 *
 * The key is a bearer credential for someone else's account, so this module is
 * built around what it refuses to hand back: `getApiKeyFingerprint` takes no
 * master key at all, which makes a display-only caller structurally incapable
 * of decrypting. Only `getApiKeyPlaintext` — named so nobody reaches for it by
 * accident — returns the real thing.
 *
 * A stored credential is a (key, PROVIDER) PAIR, not a key. Both read
 * functions return the pair rather than a bare string, because the provider
 * decides which environment variable `agent-env.ts` injects and which API the
 * orchestrator then calls — and a key handed to the wrong provider fails 401
 * AFTER the job has been queued, the project row created and the money
 * committed. Making the pair the only representable value is what stops a
 * caller forgetting the second half.
 */
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "./secrets.ts";

const FINGERPRINT_CHARS = 4;

/**
 * The providers a stored key may belong to. Mirrored EXACTLY by the `provider`
 * column's CHECK constraint (db.ts) — adding a third member here without
 * adding a migration that widens that CHECK makes every write of the new value
 * fail at the database, loudly, which is the intended direction of failure.
 */
export const API_KEY_PROVIDERS = ["anthropic", "gemini"] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

/**
 * What a key with no declared provider is. Every row that predates the
 * `provider` column IS an Anthropic key (it was the only kind that could be
 * stored), which is why the column's own DEFAULT is the same value and why the
 * migration needs to rewrite nothing.
 *
 * Safe as a silent default only because `setApiKey` refuses a key whose shape
 * belongs to a DIFFERENT provider: defaulting can leave a key unlabelled, but
 * it cannot mislabel a real key of the other provider.
 */
export const DEFAULT_API_KEY_PROVIDER: ApiKeyProvider = "anthropic";

export function isApiKeyProvider(value: unknown): value is ApiKeyProvider {
  return typeof value === "string" && (API_KEY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A shape check, not a validity check — only the provider can say whether a key
 * works. The point is to catch a pasted password or a truncated copy before it
 * is encrypted and stored as if it were a credential, and (see
 * `providerOfKeyShape`) to catch a real key submitted under the wrong provider.
 *
 * `anthropic` is slice 3's original regex, unchanged and deliberately not
 * loosened.
 *
 * `gemini` accepts BOTH of Google's key formats, because both are live:
 *   - `AIza` + exactly 35 URL-safe characters (39 total) — the older "standard"
 *     key. Length verified against a real issued key, and this is the
 *     long-standing Google API key format.
 *   - `AQ.` + 20 or more characters — the newer "auth" key. Google AI Studio
 *     now issues ONLY this kind, so a regex accepting `AIza` alone would reject
 *     every key a new tester can obtain. Its length is deliberately NOT pinned:
 *     no primary source states one, and inventing a length here would reject
 *     valid keys, which is the more expensive of the two possible mistakes. The
 *     body admits `.` because the prefix itself proves dots occur inside these
 *     keys and nothing documents where they stop.
 *
 * The two patterns cannot overlap (`sk-ant-` vs `AIza`/`AQ.`), which is what
 * makes `providerOfKeyShape` well defined.
 */
export const API_KEY_SHAPES: Readonly<Record<ApiKeyProvider, RegExp>> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  gemini: /^(?:AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9._-]{20,})$/,
};

/**
 * Which provider a key's own shape identifies, or null when no shape matches.
 *
 * Null is NOT "invalid": this function is deliberately unopinionated about a
 * key it cannot place, because refusing every unrecognised string is the HTTP
 * boundary's job (`key-routes.ts` tests the positive shape for the declared
 * provider and answers 400) and because a provider changing its key format
 * must not brick storage for keys already in hand.
 */
export function providerOfKeyShape(apiKey: string): ApiKeyProvider | null {
  for (const provider of API_KEY_PROVIDERS) {
    if (API_KEY_SHAPES[provider].test(apiKey)) return provider;
  }
  return null;
}

/**
 * Typed so a caller can map it to a legible 4xx. Names the two providers and
 * NEVER the key — the whole reason this error exists is that the value it
 * refused is a real credential for somebody's account.
 *
 * The fields are declared and assigned explicitly rather than written as
 * TypeScript PARAMETER PROPERTIES (`constructor(readonly x: T)`). That is not a
 * style preference: every entry point in this package is a `.ts` file run
 * directly by `node`, which strips types rather than compiling them, and
 * parameter properties are the one TS feature strip-only mode REFUSES
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Vitest transpiles through esbuild and
 * `tsc --noEmit` type-checks, so both stay green while the real server fails at
 * boot — this file was written the other way first, and that is exactly what
 * happened.
 */
export class ProviderMismatchError extends Error {
  readonly declaredProvider: ApiKeyProvider;
  readonly looksLikeProvider: ApiKeyProvider;

  constructor(declaredProvider: ApiKeyProvider, looksLikeProvider: ApiKeyProvider) {
    super(
      `this key's shape belongs to ${looksLikeProvider}, not ${declaredProvider}: `
      + "storing it under the wrong provider fails 401 only after work is queued",
    );
    this.name = "ProviderMismatchError";
    this.declaredProvider = declaredProvider;
    this.looksLikeProvider = looksLikeProvider;
  }
}

/**
 * Refuses a key whose shape positively identifies a provider OTHER than the
 * declared one.
 *
 * Read the asymmetry carefully, because it is deliberate: this asserts
 * AGREEMENT, not well-formedness. A key matching no known shape at all passes
 * here — `setApiKey` is a storage primitive, and the failure it exists to stop
 * is the expensive, silent one (a REAL key of the wrong provider, which reaches
 * the model API and 401s after the money is committed), not a typo, which the
 * HTTP boundary rejects strictly with a legible 400 before this is ever called.
 */
export function assertProviderAgreesWithKey(apiKey: string, provider: ApiKeyProvider): void {
  const looksLike = providerOfKeyShape(apiKey);
  if (looksLike !== null && looksLike !== provider) {
    throw new ProviderMismatchError(provider, looksLike);
  }
}

/** What may be shown: which provider, and the last four characters. Never the key. */
export interface StoredApiKeyInfo {
  fingerprint: string;
  provider: ApiKeyProvider;
}

/** The credential itself, always paired with the provider it belongs to. */
export interface StoredApiKey {
  apiKey: string;
  provider: ApiKeyProvider;
}

interface Row {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  fingerprint: string;
  provider: string;
}

/**
 * Typed, and fails closed rather than guessing. Unreachable through any
 * supported path — the column's CHECK constraint (db.ts) refuses an unknown
 * value at write time — so this covers a hand-edited database only. Guessing
 * "probably anthropic" instead would send a Gemini key to Anthropic, which is
 * exactly the mismatch this task exists to make impossible.
 */
export class UnknownStoredProviderError extends Error {
  constructor() {
    super("the stored API key names an unrecognised provider and must be re-entered");
    this.name = "UnknownStoredProviderError";
  }
}

function providerOfRow(value: string): ApiKeyProvider {
  if (!isApiKeyProvider(value)) throw new UnknownStoredProviderError();
  return value;
}

/**
 * Typed so a caller can map it to a legible 4xx instead of an opaque 500.
 * Thrown when `open()` fails — almost always a rotated WEBGEN_MASTER_KEY, the
 * one operationally realistic cause. Message names no key material and gives
 * the user something actionable: the stored value is unrecoverable and must
 * be replaced.
 */
export class UndecryptableApiKeyError extends Error {
  constructor() {
    super("the stored API key can no longer be read and must be re-entered");
    this.name = "UndecryptableApiKeyError";
  }
}

/**
 * Last four characters — enough for a user to confirm which key is stored,
 * useless to anyone who steals it (spec, BYOK requirement 3).
 */
export function fingerprintOf(apiKey: string): string {
  return apiKey.slice(-FINGERPRINT_CHARS);
}

/**
 * Upsert: one row per user, so "which key is current" can never be a question.
 *
 * Throws `ProviderMismatchError` before encrypting anything when the key's
 * shape names a different provider — the agreement check lives HERE, in the
 * storage primitive, rather than only at the HTTP boundary, so no future caller
 * can store a mislabelled credential by going around a route.
 *
 * `provider` defaults for exactly one reason: every call site that predates the
 * column was storing an Anthropic key. See `DEFAULT_API_KEY_PROVIDER` for why
 * the default cannot mislabel a real key.
 */
export function setApiKey(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  apiKey: string,
  provider: ApiKeyProvider = DEFAULT_API_KEY_PROVIDER,
): string {
  assertProviderAgreesWithKey(apiKey, provider);
  const sealed = seal(masterKey, apiKey);
  const fingerprint = fingerprintOf(apiKey);
  db.prepare(
    `INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       nonce = excluded.nonce,
       fingerprint = excluded.fingerprint,
       provider = excluded.provider,
       created_at = excluded.created_at`,
  ).run(userId, sealed.ciphertext, sealed.nonce, fingerprint, provider, Date.now());
  return fingerprint;
}

/**
 * The display-only read: which provider, and the last four characters.
 *
 * Takes NO master key, and that is a structural property rather than an
 * omission — a caller that only wants to render "gemini · ••••XY9z" is
 * incapable of decrypting anything. Adding the provider to the result must not
 * change that, so the provider is read straight from its own column and never
 * derived from the key.
 */
export function getApiKeyFingerprint(db: DatabaseSync, userId: string): StoredApiKeyInfo | null {
  const row = db.prepare("SELECT fingerprint, provider FROM api_key WHERE user_id = ?").get(userId) as
    | { fingerprint: string; provider: string }
    | undefined;
  if (row === undefined) return null;
  return { fingerprint: row.fingerprint, provider: providerOfRow(row.provider) };
}

/**
 * The only path to the real key. Throws rather than returning a wrong value if
 * the master key has changed since the row was written — a rotated key must
 * fail loudly, not send garbage to a provider as somebody's credential.
 *
 * Returns the key WITH its provider, never alone: the caller's next act is to
 * choose an environment variable, and the two halves must not be separable.
 */
export function getApiKeyPlaintext(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
): StoredApiKey | null {
  const row = db.prepare("SELECT * FROM api_key WHERE user_id = ?").get(userId) as Row | undefined;
  if (row === undefined) return null;
  // Read (and validate) the provider BEFORE decrypting: there is no reason to
  // hold plaintext in memory for a row that is about to be refused anyway.
  const provider = providerOfRow(row.provider);
  try {
    // node:sqlite hands back a Uint8Array for a BLOB; the cipher needs a Buffer.
    return {
      apiKey: open(masterKey, {
        ciphertext: Buffer.from(row.ciphertext),
        nonce: Buffer.from(row.nonce),
      }),
      provider,
    };
  } catch {
    // `open()` throws node's bare, untyped GCM message ("Unsupported state or
    // unable to authenticate data") on a wrong key or tampered ciphertext.
    // Rethrown as a typed error so a caller can map it to a 4xx — an
    // untyped throw here reaches router.ts's catch-all as an opaque 500
    // with no log line, indistinguishable from a genuine server bug.
    throw new UndecryptableApiKeyError();
  }
}

/** Silent when there is nothing to delete: revoking twice is not an error. */
export function deleteApiKey(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM api_key WHERE user_id = ?").run(userId);
}
