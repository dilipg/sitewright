// server/src/db.test.ts
/**
 * The identity store. It holds WHO owns what — never project content, which
 * stays on the filesystem (spec, decision 4).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
