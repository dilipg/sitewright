/**
 * Password hashing. No I/O, no database — so it can be tested exhaustively and
 * cheaply, and so nothing else in the system needs to know how a hash is made.
 */
import { randomInt } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";

/** URL-safe and shell-safe: the operator copies a generated password out of a terminal. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const LENGTH = 20;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: Algorithm.Argon2id });
}

/**
 * Returns false rather than throwing on a malformed hash: a corrupted row
 * should fail one login, not crash the request handler.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/**
 * `randomInt` rather than `Math.random`: this is a credential.
 * Rejection-free because 64 divides the range evenly, so no modulo bias.
 */
export function generatePassword(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
