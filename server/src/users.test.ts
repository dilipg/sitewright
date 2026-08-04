import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";
import {
  createUser, findUserByEmail, findUserById, listUsers,
  setDisabled, setPasswordHash, setSpendCap,
} from "./users.ts";

const dirs: string[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "server-users-"));
  dirs.push(dir);
  return openDatabase(join(dir, "identity.db"));
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("users", () => {
  it("creates and finds a user by email", () => {
    const db = freshDb();
    const created = createUser(db, "a@example.com", "hash");
    expect(created.email).toBe("a@example.com");
    expect(findUserByEmail(db, "a@example.com")?.id).toBe(created.id);
    db.close();
  });

  it("defaults the spend cap to 10", () => {
    // The spec's $10/24h default. If this drifts, every new account silently
    // gets a different budget from the one documented.
    const db = freshDb();
    expect(createUser(db, "a@example.com", "h").spendCapUsd).toBe(10);
    db.close();
  });

  it("treats email case-insensitively", () => {
    // Otherwise Alice@ and alice@ are two accounts and the operator creates a
    // duplicate without being told.
    const db = freshDb();
    createUser(db, "Alice@Example.com", "h");
    expect(findUserByEmail(db, "alice@example.com")).not.toBeNull();
    expect(() => createUser(db, "alice@EXAMPLE.com", "h")).toThrow();
    db.close();
  });

  it("returns null for an unknown email or id rather than throwing", () => {
    const db = freshDb();
    expect(findUserByEmail(db, "nobody@example.com")).toBeNull();
    expect(findUserById(db, "nope")).toBeNull();
    db.close();
  });

  it("gives every user a distinct id", () => {
    const db = freshDb();
    const ids = new Set([
      createUser(db, "a@example.com", "h").id,
      createUser(db, "b@example.com", "h").id,
      createUser(db, "c@example.com", "h").id,
    ]);
    expect(ids.size).toBe(3);
    db.close();
  });

  it("changes a password hash", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "old");
    setPasswordHash(db, user.id, "new");
    expect(findUserById(db, user.id)?.passwordHash).toBe("new");
    db.close();
  });

  it("disables and re-enables a user", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    expect(findUserById(db, user.id)?.disabledAt).toBeNull();

    setDisabled(db, user.id, true);
    expect(findUserById(db, user.id)?.disabledAt).toBeTypeOf("number");

    setDisabled(db, user.id, false);
    expect(findUserById(db, user.id)?.disabledAt).toBeNull();
    db.close();
  });

  it("sets a spend cap", () => {
    const db = freshDb();
    const user = createUser(db, "a@example.com", "h");
    setSpendCap(db, user.id, 50);
    expect(findUserById(db, user.id)?.spendCapUsd).toBe(50);
    db.close();
  });

  it("lists users in creation order", () => {
    const db = freshDb();
    createUser(db, "a@example.com", "h");
    createUser(db, "b@example.com", "h");
    expect(listUsers(db).map((u) => u.email)).toEqual(["a@example.com", "b@example.com"]);
    db.close();
  });
});
