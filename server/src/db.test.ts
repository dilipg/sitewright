// server/src/db.test.ts
/**
 * The identity store. It holds WHO owns what — never project content, which
 * stays on the filesystem (spec, decision 4).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "./db.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-db-"));
  dirs.push(dir);
  return join(dir, "identity.db");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the file and both tables", () => {
    const db = openDatabase(tempDbPath());
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("user");
    expect(names).toContain("session");
    db.close(); // release the handle so afterAll can remove the temp dir on Windows
  });

  it("is idempotent — opening an existing database does not throw or wipe data", () => {
    // Migrations run on every boot, so re-running them must be a no-op. If it
    // is not, the first restart of the server destroys every account.
    const path = tempDbPath();
    const first = openDatabase(path);
    first.prepare("INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "a@example.com", "hash", 10, 1);
    first.close();

    const second = openDatabase(path);
    const rows = second.prepare("SELECT email FROM user").all();
    expect(rows).toEqual([{ email: "a@example.com" }]);
    second.close(); // release the handle so afterAll can remove the temp dir on Windows
  });

  it("enforces email uniqueness", () => {
    const db = openDatabase(tempDbPath());
    const insert = db.prepare(
      "INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("u1", "a@example.com", "h", 10, 1);
    expect(() => insert.run("u2", "a@example.com", "h", 10, 1)).toThrow();
    db.close(); // release the handle so afterAll can remove the temp dir on Windows
  });

  it("deletes a user's sessions when the user is deleted", () => {
    // Foreign keys are OFF by default in SQLite. If openDatabase forgets to
    // enable them, orphaned sessions survive and a deleted user stays logged in.
    const db = openDatabase(tempDbPath());
    db.prepare("INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "a@example.com", "h", 10, 1);
    db.prepare("INSERT INTO session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run("s1", "u1", 999, 1);

    db.prepare("DELETE FROM user WHERE id = ?").run("u1");
    expect(db.prepare("SELECT id FROM session").all()).toEqual([]);
    db.close(); // release the handle so afterAll can remove the temp dir on Windows
  });

  it("sets busy_timeout to 5000, so a concurrent writer retries instead of failing instantly", () => {
    const db = openDatabase(tempDbPath());
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(5000);
    db.close();
  });

  // Every other test in this file uses a single connection, which is exactly
  // why no earlier review caught the missing busy_timeout: a lock only
  // exists once a SECOND connection tries to write while the first still
  // holds one open, mirroring the CLI and the server as two real processes on
  // one WAL file. A worker thread holds an open write transaction (its own
  // real DatabaseSync connection) while this test's own connection attempts a
  // write — the worker's setTimeout runs on its own event loop, independent
  // of this thread being blocked inside the write call, so the lock really
  // does get released mid-retry rather than the test faking concurrency.
  it(
    "lets a second real connection wait and succeed rather than throwing 'database is locked'",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "server-db-busy-"));
      dirs.push(dir);
      const dbPath = join(dir, "identity.db");

      // Create the schema up front on a throwaway connection so the worker
      // and the test's own connection agree on it without racing each other.
      openDatabase(dbPath).close();

      const workerScript = join(dir, "lock-holder.cjs");
      const holdMs = 300;
      writeFileSync(
        workerScript,
        `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

db.exec("BEGIN IMMEDIATE");
db.prepare(
  "INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
).run("lock-holder", "locker@example.com", "h", 10, Date.now());

parentPort.postMessage("locked");

setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  parentPort.postMessage("released");
}, workerData.holdMs);
`,
      );

      const worker = new Worker(workerScript, { workerData: { path: dbPath, holdMs } });
      const locked = new Promise<void>((resolve, reject) => {
        worker.once("message", (msg) => { if (msg === "locked") resolve(); });
        worker.once("error", reject);
      });
      const released = new Promise<void>((resolve, reject) => {
        worker.on("message", (msg) => { if (msg === "released") resolve(); });
        worker.once("error", reject);
      });

      try {
        await locked; // the worker now genuinely holds an open write transaction

        const db2 = openDatabase(dbPath); // a second, independent real connection
        const start = performance.now();
        expect(() => {
          db2.prepare(
            "INSERT INTO user (id, email, password_hash, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run("second-writer", "second@example.com", "h", 10, Date.now());
        }).not.toThrow();
        const elapsed = performance.now() - start;

        // Not instantaneous — it genuinely waited on the lock rather than
        // winning a race — and comfortably inside the 5000ms ceiling, so the
        // success came from retrying, not from luck.
        expect(elapsed).toBeGreaterThan(holdMs / 4);
        expect(elapsed).toBeLessThan(5000);

        db2.close(); // release the handle so afterAll can remove the temp dir on Windows
        await released;
      } finally {
        await worker.terminate();
      }
    },
    8000,
  );

  it("adds run_id, code_version and resumed_from_job_id to the job table (task 7)", () => {
    const db = openDatabase(tempDbPath());
    const columns = (db.prepare("PRAGMA table_info(job)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["run_id", "code_version", "resumed_from_job_id"]));
    db.close();
  });

  it(
    "adding the task-7 job columns is idempotent — opening an existing database a second time does not throw 'duplicate column name'",
    () => {
      // SQLite's ALTER TABLE ADD COLUMN has no declarative IF NOT EXISTS, so
      // this is the property db.ts's own ensureColumn() helper exists for —
      // perturbing it back to a bare, unconditional ALTER TABLE (no
      // PRAGMA table_info check first) makes THIS test fail on the second
      // open with "duplicate column name: run_id", exactly the crash a real
      // server restart would hit. Covers I7's `job.provider` too, since it
      // rides the same helper — any later column added the same way is
      // protected by this test without it having to name them.
      const path = tempDbPath();
      openDatabase(path).close();
      expect(() => openDatabase(path).close()).not.toThrow();
    },
  );

  it("adds provider to the job table, NULLABLE and with NO default (fix round B, I7)", () => {
    const db = openDatabase(tempDbPath());
    const provider = (db.prepare("PRAGMA table_info(job)").all() as Array<{
      name: string; notnull: number; dflt_value: string | null;
    }>).find((c) => c.name === "provider");
    expect(provider).toBeDefined();
    // Both pinned, because both are the decision rather than an oversight: NULL
    // is the truthful value for a row that predates the column (and for every
    // job that makes no model call), and a DEFAULT would claim a provider for
    // work that never used one — which the resume guard would then read as a
    // real mismatch and refuse.
    expect(provider?.notnull).toBe(0);
    expect(provider?.dflt_value).toBe(null);
    db.close();
  });

  it("refuses an unrecognised job provider at the database, so api-keys.ts's union is structural here too (I7)", () => {
    const db = openDatabase(tempDbPath());
    db.prepare("INSERT INTO user (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("u1", "a@example.com", "h", 1);
    db.prepare(
      "INSERT INTO job (id, user_id, project_id, kind, status, request_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
    ).run("j1", "u1", "regen", "queued", "{}", 1);

    // The two real members and NULL are all writable...
    for (const value of ["anthropic", "gemini", null]) {
      expect(() => db.prepare("UPDATE job SET provider = ? WHERE id = ?").run(value, "j1")).not.toThrow();
    }
    // ...and nothing else is, by any caller, including one that bypasses
    // recordJobRun. This is what keeps `providersIncompatible`'s fail-closed
    // branch a guard against a hand-edited file rather than an ordinary path.
    expect(() => db.prepare("UPDATE job SET provider = ? WHERE id = ?").run("openai", "j1"))
      .toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("adds provider to the api_key table, defaulting to anthropic (BYOK task 1)", () => {
    const db = openDatabase(tempDbPath());
    const provider = (db.prepare("PRAGMA table_info(api_key)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>).find((c) => c.name === "provider");
    expect(provider).toBeDefined();
    // The DEFAULT is the whole backward-compatibility mechanism, so it is
    // pinned exactly rather than merely "is not null".
    expect(provider?.dflt_value).toBe("'anthropic'");
    expect(provider?.notnull).toBe(1);
    db.close();
  });

  it(
    "migrates a PRE-EXISTING database that already holds an Anthropic key, and the key still decrypts",
    async () => {
      // The worst outcome available in this task is a migration that breaks
      // stored keys, so this does not test a fresh database with the column
      // already in its CREATE — it builds the schema slice 3 ACTUALLY shipped
      // (no provider column at all), stores a real sealed key through it, and
      // only then opens it with the migration in place.
      const { seal, open } = await import("./secrets.ts");
      const { getApiKeyFingerprint, getApiKeyPlaintext } = await import("./api-keys.ts");
      const { randomBytes } = await import("node:crypto");
      const masterKey = randomBytes(32);
      const KEY = "sk-ant-api03-a-real-looking-stored-key-XY9z";
      const path = tempDbPath();

      // --- Slice 3's schema, verbatim: api_key with FIVE columns. ---
      const legacy = new DatabaseSync(path);
      legacy.exec("PRAGMA foreign_keys = ON");
      legacy.exec(`CREATE TABLE user (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        spend_cap_usd REAL NOT NULL DEFAULT 10, created_at INTEGER NOT NULL, disabled_at INTEGER)`);
      legacy.exec(`CREATE TABLE api_key (
        user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
        ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL)`);
      legacy.prepare("INSERT INTO user (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run("u1", "a@example.com", "h", 1);
      const sealed = seal(masterKey, KEY);
      legacy.prepare(
        "INSERT INTO api_key (user_id, ciphertext, nonce, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("u1", sealed.ciphertext, sealed.nonce, "XY9z", 1);
      expect((legacy.prepare("PRAGMA table_info(api_key)").all() as Array<{ name: string }>))
        .toHaveLength(5); // no provider column yet — the premise of this test
      legacy.close();

      // --- Boot the real server code against that file. ---
      const migrated = openDatabase(path);
      // The row was NOT rewritten: same ciphertext, same nonce, same fingerprint.
      const row = migrated.prepare("SELECT * FROM api_key WHERE user_id = ?").get("u1") as {
        ciphertext: Uint8Array; nonce: Uint8Array; fingerprint: string; provider: string;
      };
      expect(Buffer.from(row.ciphertext).equals(sealed.ciphertext)).toBe(true);
      expect(Buffer.from(row.nonce).equals(sealed.nonce)).toBe(true);
      expect(row.fingerprint).toBe("XY9z");
      expect(row.provider).toBe("anthropic");
      // And it still DECRYPTS — the assertion this test exists for. Checked
      // both through the module and through the raw cipher, so a change to
      // api-keys.ts cannot mask a genuinely corrupted row.
      expect(open(masterKey, { ciphertext: Buffer.from(row.ciphertext), nonce: Buffer.from(row.nonce) })).toBe(KEY);
      expect(getApiKeyPlaintext(migrated, masterKey, "u1")).toEqual({ apiKey: KEY, provider: "anthropic" });
      expect(getApiKeyFingerprint(migrated, "u1")).toEqual({ fingerprint: "XY9z", provider: "anthropic" });
      migrated.close();

      // --- And a SECOND boot is a no-op, not "duplicate column name". ---
      const again = openDatabase(path);
      expect(getApiKeyPlaintext(again, masterKey, "u1")).toEqual({ apiKey: KEY, provider: "anthropic" });
      again.close();
    },
  );

  it("defaults spend_cap_usd to 10 when the column is omitted", () => {
    // The $10/24h cap is a documented product decision (see the brief). A
    // future migration typo or copy-paste of the user DDL that drops or
    // changes DEFAULT 10 must fail loudly here, not silently ship a
    // different cap.
    const db = openDatabase(tempDbPath());
    db.prepare("INSERT INTO user (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("u1", "a@example.com", "h", 1);
    const row = db.prepare("SELECT spend_cap_usd FROM user WHERE id = ?").get("u1");
    expect(row).toEqual({ spend_cap_usd: 10 });
    db.close(); // release the handle so afterAll can remove the temp dir on Windows
  });
});
