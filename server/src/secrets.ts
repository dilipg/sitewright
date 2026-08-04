/**
 * Authenticated encryption for values held at rest.
 *
 * Knows nothing about users, HTTP or SQLite, so it can be tested exhaustively
 * and so nothing else needs to know how sealing works.
 *
 * AES-256-GCM rather than AES-CBC: GCM authenticates as well as encrypts, so a
 * modified ciphertext fails loudly instead of decrypting to a value we would
 * then send to Anthropic as somebody's credential.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96 bits, GCM's standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Sealed {
  /** Ciphertext with the 16-byte GCM auth tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
}

function assertKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`);
  }
}

export function seal(masterKey: Buffer, plaintext: string): Sealed {
  assertKey(masterKey);
  // A fresh nonce per call. Reusing one under the same key is the single
  // catastrophic misuse of GCM — it leaks the keystream.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Tag appended rather than given its own column, so the table keeps exactly
  // the columns the spec names. Same layout libsodium's secretbox uses.
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function open(masterKey: Buffer, sealed: Sealed): string {
  assertKey(masterKey);
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new Error("ciphertext is too short to contain an authentication tag");
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, masterKey, sealed.nonce);
  decipher.setAuthTag(tag);
  // `final()` is what throws on a bad tag — this is the authentication check,
  // not a formality.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
