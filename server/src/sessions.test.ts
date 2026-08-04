import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";
import { createUser, setDisabled } from "./users.ts";
import {
  createSession, deleteExpiredSessions, resolveSession,
  revokeAllSessionsForUser, revokeSession, SESSION_TTL_MS,
} from "./sessions.ts";

const dirs: string[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "server-sessions-"));
  dirs.push(dir);
  return openDatabase(join(dir, "identity.db"));
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("resolves a fresh session to its user", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const session = createSession(db, user.id);
    expect(resolveSession(db, session.id)?.id).toBe(user.id);
    db.close();
  });

  it("returns null for an unknown session id", () => {
    const db = freshDb();
    expect(resolveSession(db, "made-up")).toBeNull();
    db.close();
  });

  it("issues unguessable ids", () => {
    // A session id IS the credential. Sequential or short ids are guessable.
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const ids = Array.from({ length: 20 }, () => createSession(db, user.id).id);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(32);
    db.close();
  });

  it("refuses an expired session", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const session = createSession(db, user.id, 1000);
    expect(resolveSession(db, session.id, 1000 + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(resolveSession(db, session.id, 1000 + SESSION_TTL_MS + 1)).toBeNull();
    db.close();
  });

  it("is dead exactly at its expiry instant", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const session = createSession(db, user.id, 1000);
    expect(resolveSession(db, session.id, 1000 + SESSION_TTL_MS)).toBeNull();
    db.close();
  });

  it("refuses a session belonging to a disabled user, without needing revocation", () => {
    // This is what makes invite-only revocation immediate: disabling the
    // account must lock out live sessions, not just prevent new logins.
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const session = createSession(db, user.id);
    setDisabled(db, user.id, true);
    expect(resolveSession(db, session.id)).toBeNull();
    db.close();
  });

  it("revokes one session and leaves the others", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const first = createSession(db, user.id);
    const second = createSession(db, user.id);
    revokeSession(db, first.id);
    expect(resolveSession(db, first.id)).toBeNull();
    expect(resolveSession(db, second.id)).not.toBeNull();
    db.close();
  });

  it("revokes every session for a user", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    const sessions = [createSession(db, user.id), createSession(db, user.id)];
    revokeAllSessionsForUser(db, user.id);
    for (const session of sessions) expect(resolveSession(db, session.id)).toBeNull();
    db.close();
  });

  it("prunes expired rows and reports how many", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    createSession(db, user.id, 1000);
    createSession(db, user.id, 1000);
    const live = createSession(db, user.id, 5_000_000_000);
    expect(deleteExpiredSessions(db, 1000 + SESSION_TTL_MS + 1)).toBe(2);
    expect(resolveSession(db, live.id, 5_000_000_000)).not.toBeNull();
    db.close();
  });
});
