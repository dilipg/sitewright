/**
 * One Anthropic API key per user, encrypted at rest.
 *
 * The key is a bearer credential for someone else's account, so this module is
 * built around what it refuses to hand back: `getApiKeyFingerprint` takes no
 * master key at all, which makes a display-only caller structurally incapable
 * of decrypting. Only `getApiKeyPlaintext` — named so nobody reaches for it by
 * accident — returns the real thing.
 */
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "./secrets.ts";

const FINGERPRINT_CHARS = 4;

interface Row {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  fingerprint: string;
}

/**
 * Last four characters — enough for a user to confirm which key is stored,
 * useless to anyone who steals it (spec, BYOK requirement 3).
 */
export function fingerprintOf(apiKey: string): string {
  return apiKey.slice(-FINGERPRINT_CHARS);
}

/** Upsert: one row per user, so "which key is current" can never be a question. */
export function setApiKey(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  apiKey: string,
): string {
  const sealed = seal(masterKey, apiKey);
  const fingerprint = fingerprintOf(apiKey);
  db.prepare(
    `INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       nonce = excluded.nonce,
       fingerprint = excluded.fingerprint,
       created_at = excluded.created_at`,
  ).run(userId, sealed.ciphertext, sealed.nonce, fingerprint, Date.now());
  return fingerprint;
}

export function getApiKeyFingerprint(db: DatabaseSync, userId: string): string | null {
  const row = db.prepare("SELECT fingerprint FROM api_key WHERE user_id = ?").get(userId) as
    | { fingerprint: string }
    | undefined;
  return row === undefined ? null : row.fingerprint;
}

/**
 * The only path to the real key. Throws rather than returning a wrong value if
 * the master key has changed since the row was written — a rotated key must
 * fail loudly, not send garbage to Anthropic as somebody's credential.
 */
export function getApiKeyPlaintext(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
): string | null {
  const row = db.prepare("SELECT * FROM api_key WHERE user_id = ?").get(userId) as Row | undefined;
  if (row === undefined) return null;
  // node:sqlite hands back a Uint8Array for a BLOB; the cipher needs a Buffer.
  return open(masterKey, {
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
  });
}

/** Silent when there is nothing to delete: revoking twice is not an error. */
export function deleteApiKey(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM api_key WHERE user_id = ?").run(userId);
}
