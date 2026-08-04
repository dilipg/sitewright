/**
 * User rows. Knows nothing about hashing (that is `passwords.ts`) and nothing
 * about HTTP — it takes an already-hashed password and stores it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  spendCapUsd: number;
  createdAt: number;
  disabledAt: number | null;
}

interface Row {
  id: string;
  email: string;
  password_hash: string;
  spend_cap_usd: number;
  created_at: number;
  disabled_at: number | null;
}

function toUser(row: Row): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    spendCapUsd: row.spend_cap_usd,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

/** Stored and compared lowercase: otherwise Alice@ and alice@ are two accounts. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUser(db: DatabaseSync, email: string, passwordHash: string): User {
  const user: User = {
    id: randomUUID(),
    email: normalizeEmail(email),
    passwordHash,
    spendCapUsd: 10,
    createdAt: Date.now(),
    disabledAt: null,
  };
  db.prepare(
    "INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(user.id, user.email, user.passwordHash, user.spendCapUsd, user.createdAt);
  return user;
}

export function findUserByEmail(db: DatabaseSync, email: string): User | null {
  const row = db.prepare("SELECT * FROM user WHERE email = ?").get(normalizeEmail(email)) as
    | Row
    | undefined;
  return row === undefined ? null : toUser(row);
}

export function findUserById(db: DatabaseSync, id: string): User | null {
  const row = db.prepare("SELECT * FROM user WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toUser(row);
}

export function setPasswordHash(db: DatabaseSync, id: string, passwordHash: string): void {
  db.prepare("UPDATE user SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function setDisabled(db: DatabaseSync, id: string, disabled: boolean): void {
  db.prepare("UPDATE user SET disabled_at = ? WHERE id = ?").run(disabled ? Date.now() : null, id);
}

export function setSpendCap(db: DatabaseSync, id: string, capUsd: number): void {
  db.prepare("UPDATE user SET spend_cap_usd = ? WHERE id = ?").run(capUsd, id);
}

export function listUsers(db: DatabaseSync): User[] {
  return (db.prepare("SELECT * FROM user ORDER BY created_at, email").all() as unknown as Row[]).map(toUser);
}
