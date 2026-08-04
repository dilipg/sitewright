// server/src/db.test.ts
/**
 * The identity store. It holds WHO owns what — never project content, which
 * stays on the filesystem (spec, decision 4).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
