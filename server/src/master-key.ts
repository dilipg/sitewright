/**
 * The AES master key, and the only place it is read.
 *
 * It lives in an environment variable and nowhere else — not the repo, not the
 * database, not a committed .env (spec, BYOK requirement 1). There is
 * deliberately no fallback: a default master key looks like encryption while
 * making every deployment's ciphertext readable by anyone holding the source.
 * Refusing to boot is the correct failure.
 */
export const MASTER_KEY_ENV_VAR = "WEBGEN_MASTER_KEY";

const REQUIRED_BYTES = 32; // AES-256

/**
 * Generate one with:
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 *
 * Errors never include the value: an operator pastes this into a shell, and a
 * boot message that echoes it back undoes the effort of keeping it out of the
 * repository.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[MASTER_KEY_ENV_VAR];
  if (raw === undefined || raw === "") {
    throw new Error(
      `${MASTER_KEY_ENV_VAR} is not set. The server will not start without it. ` +
        `Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  // Buffer.from is famously lenient — it ignores characters outside the base64
  // alphabet rather than throwing — so a typo would otherwise silently produce
  // a short key. Re-encoding and comparing is what actually rejects it. Note
  // this also rejects base64url and unpadded base64: both decode to the
  // correct 32 bytes but re-encode to a *different* string (`+`/`/` instead
  // of `-`/`_`, and restored `=` padding), so they fail this comparison too —
  // correctly, since the check's job is to catch a typo, but the message
  // below must say so, not blame "not valid base64" for a value that a typo
  // never produced.
  const decoded = Buffer.from(raw, "base64");
  if (decoded.toString("base64") !== raw.trim()) {
    throw new Error(
      `${MASTER_KEY_ENV_VAR} is not valid base64. It must be canonical, padded ` +
        `base64 (RFC 4648 §4) — base64url and unpadded base64 are rejected even ` +
        `when they decode to the correct 32 bytes.`,
    );
  }
  if (decoded.length !== REQUIRED_BYTES) {
    throw new Error(
      `${MASTER_KEY_ENV_VAR} must decode to exactly ${REQUIRED_BYTES} bytes (got ${decoded.length}).`,
    );
  }
  return decoded;
}
