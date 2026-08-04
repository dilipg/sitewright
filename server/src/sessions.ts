/**
 * Server-side sessions, deliberately not JWTs (spec, decision 12). Revocation
 * is the whole point: invite-only means removing someone has to take effect
 * immediately, and a stateless token cannot be withdrawn.
 *
 * `resolveSession` re-reads the user on every request rather than trusting
 * anything cached in the session row, so disabling an account locks out its
 * live sessions without needing to hunt them down.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { User } from "./users.ts";
import { findUserById } from "./users.ts";

/**
 * Lives here, not in auth-routes.ts: require-session.ts needs this string and
 * nothing else from the unauthenticated-routes module, and importing it from
 * there would pull in @node-rs/argon2 just to learn "sid" — and, once
 * anything wraps GET /api/me in requireSession, become a real import cycle
 * (auth-routes.ts -> require-session.ts -> auth-routes.ts). auth-routes.ts
 * re-exports this so existing importers keep working unchanged.
 */
export const SESSION_COOKIE = "sid";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createSession(
  db: DatabaseSync,
  userId: string,
  now: number = Date.now(),
): { id: string; expiresAt: number } {
  // 32 bytes of CSPRNG: the session id IS the credential, so it must be
  // unguessable, not merely unique.
  const id = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare("INSERT INTO session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    expiresAt,
    now,
  );
  return { id, expiresAt };
}

export function resolveSession(
  db: DatabaseSync,
  sessionId: string,
  now: number = Date.now(),
): User | null {
  const row = db.prepare("SELECT user_id, expires_at FROM session WHERE id = ?").get(sessionId) as
    | { user_id: string; expires_at: number }
    | undefined;
  if (row === undefined || row.expires_at <= now) return null;
  const user = findUserById(db, row.user_id);
  if (user === null || user.disabledAt !== null) return null;
  return user;
}

export function revokeSession(db: DatabaseSync, sessionId: string): void {
  db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
}

export function revokeAllSessionsForUser(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM session WHERE user_id = ?").run(userId);
}

/** Housekeeping; returns the number of rows removed. */
export function deleteExpiredSessions(db: DatabaseSync, now: number = Date.now()): number {
  const result = db.prepare("DELETE FROM session WHERE expires_at <= ?").run(now);
  return Number(result.changes);
}
