// server/src/db.ts
/**
 * The identity store: who exists and who is logged in.
 *
 * Deliberately NOT a home for project content — generated projects stay on the
 * filesystem exactly as they are (spec, decision 4). This database records who
 * owns which directory, never what is in it. Mixing the two would mean
 * rewriting the compiler.
 *
 * `node:sqlite` rather than better-sqlite3: Node 24 ships it, so the identity
 * store costs zero native dependencies.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Applied in order, every boot. Each must be idempotent on its own, because
 * they run again on every restart — a migration that is not idempotent
 * destroys every account the first time the server is restarted.
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS user (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     spend_cap_usd REAL NOT NULL DEFAULT 10,
     created_at    INTEGER NOT NULL,
     disabled_at   INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS session (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id)`,
  `CREATE TABLE IF NOT EXISTS api_key (
     user_id     TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
     ciphertext  BLOB NOT NULL,
     nonce       BLOB NOT NULL,
     fingerprint TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project (
     id         TEXT PRIMARY KEY,
     owner_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     directory  TEXT NOT NULL UNIQUE,
     name       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS usage_event (
     id                          TEXT PRIMARY KEY,
     user_id                     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     project_id                  TEXT REFERENCES project(id) ON DELETE SET NULL,
     role                        TEXT NOT NULL,
     model                       TEXT NOT NULL,
     input_tokens                INTEGER NOT NULL DEFAULT 0,
     output_tokens               INTEGER NOT NULL DEFAULT 0,
     cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
     cost_usd                    REAL,
     at                          INTEGER NOT NULL
   )`,
  // Every cap check is "this user, this window" — without the index that is a
  // full scan of every user's history on each request that starts work.
  `CREATE INDEX IF NOT EXISTS usage_event_user_at_idx ON usage_event(user_id, at)`,
];

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Foreign keys are OFF by default in SQLite. Without this, deleting a user
  // leaves their sessions behind and they stay logged in after removal —
  // which is exactly what invite-only revocation must not allow.
  db.exec("PRAGMA foreign_keys = ON");
  // WAL: the server reads sessions on every request while writes happen
  // concurrently; the default rollback journal serialises them.
  db.exec("PRAGMA journal_mode = WAL");
  // WAL permits many concurrent readers but still only one writer at a time.
  // The CLI and the server are two separate processes on the same file, and
  // the default busy_timeout is 0 — the loser of a write race throws
  // ERR_SQLITE_ERROR: database is locked immediately instead of retrying.
  // That surfaces as an emergency `disable` silently failing to apply, or a
  // 500 on a correct login from inside createSession. 5s is comfortably
  // longer than any single write transaction this schema ever holds open.
  db.exec("PRAGMA busy_timeout = 5000");
  for (const migration of MIGRATIONS) db.exec(migration);
  return db;
}
