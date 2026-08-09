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
  // Long-running work (slice 5): a job outlives the request that created it,
  // so it is tracked here rather than held in memory, and a disconnect never
  // loses it. project_id is SET NULL like usage_event — deleting a project
  // must not erase the record that work was paid for. user_id cascades,
  // matching the rest of the schema.
  `CREATE TABLE IF NOT EXISTS job (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     project_id   TEXT REFERENCES project(id) ON DELETE SET NULL,
     kind         TEXT NOT NULL,
     status       TEXT NOT NULL,
     request_json TEXT NOT NULL,
     result_json  TEXT,
     error        TEXT,
     created_at   INTEGER NOT NULL,
     started_at   INTEGER,
     finished_at  INTEGER
   )`,
  // Serves `countActiveJobsForUser` ("this user, these statuses") and
  // `claimNextJob`'s own per-user-running-count subquery, both "this user,
  // this status" lookups that would otherwise scan every job ever recorded.
  // Does NOT serve `listJobsByProject`, which filters on `project_id` (a
  // column this index does not cover) and full-scans regardless — nothing
  // needs an index for that yet, so none is added here.
  `CREATE INDEX IF NOT EXISTS job_user_status_idx ON job(user_id, status)`,
];

/**
 * Task 7 (resume-from-failure): three nullable columns added to the
 * ALREADY-SHIPPED `job` table, kept OUT of the `MIGRATIONS` array above on
 * purpose. SQLite's `ALTER TABLE ... ADD COLUMN` has no declarative `IF NOT
 * EXISTS` the way `CREATE TABLE`/`CREATE INDEX` do — a bare string re-run on
 * every boot would throw "duplicate column name" the second time — so
 * idempotency here is checked by hand via `PRAGMA table_info`, applied after
 * the main migration loop runs. Same rule ("idempotent every boot") as
 * `MIGRATIONS`'s own comment states, just expressed the only way this
 * particular kind of schema change can be in SQLite.
 *
 *  - `run_id`: the Kitaru run id a job's own execution used — null until
 *    `jobs.ts`'s `recordJobRun` stamps it, at the moment `job-worker.ts`
 *    actually starts running the job (not at enqueue). Pre-populated at
 *    CREATION only for a job made by `POST /api/jobs/:id/resume`, copied
 *    verbatim from the job it resumes.
 *  - `code_version`: the server's own code version at the moment a job
 *    started running — recorded by the same call as `run_id`, for the same
 *    reason. This is the safety rail against resuming across a deploy that
 *    edited a checkpoint's body (docs/decisions.md, 2026-07-28 row); see
 *    `job-routes.ts`'s resume handler for the 409 this enables.
 *  - `resumed_from_job_id`: set only on a job created by `POST
 *    /api/jobs/:id/resume`, naming the original failed job — the durable
 *    half of "linked to the original, so the audit trail shows two attempts
 *    rather than one mutated row" (task-7 brief). `ON DELETE SET NULL`,
 *    the same convention `project_id` above already uses: there is no job
 *    delete path today, but nothing here should assume there never will be
 *    one, and a deleted job must not corrupt an unrelated row's history.
 */
/**
 * Task-7-review finding 4: the check-then-ALTER above is idempotent within
 * ONE process's lifetime, but not across two processes racing their FIRST
 * boot on the same file — the server and `user-cli.ts` are exactly such a
 * pair. Both can run the `PRAGMA table_info` read, both see the column
 * absent (neither has committed yet), and both then attempt the `ALTER`;
 * `busy_timeout` serialises the two writes but does not make the LOSER's
 * write succeed — it still throws `duplicate column name`, now as a boot
 * crash rather than a silent no-op. The column exists either way (the
 * winner just added it moments earlier), which is exactly the postcondition
 * this function promises — so the loser's failure is caught and swallowed
 * SPECIFICALLY when it is this one, named, expected race, never any other
 * `ALTER TABLE` failure (a genuinely malformed `columnDdl`, a disk error,
 * ...), which must still surface.
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, columnDdl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("duplicate column name")) throw err;
  }
}

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
  ensureColumn(db, "job", "run_id", "run_id TEXT");
  ensureColumn(db, "job", "code_version", "code_version TEXT");
  ensureColumn(db, "job", "resumed_from_job_id", "resumed_from_job_id TEXT REFERENCES job(id) ON DELETE SET NULL");
  return db;
}
