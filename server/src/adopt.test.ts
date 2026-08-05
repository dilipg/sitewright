// server/src/adopt.test.ts
/**
 * There are real acceptance runs in generated/ worth keeping (spec,
 * Operational requirements), so first boot adopts them rather than orphaning
 * them. Idempotency is the property that matters: this runs on EVERY boot.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { listAllProjects } from "./projects.ts";
import { adoptExistingProjects } from "./adopt.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh(projectDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "server-adopt-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const root = join(dir, "generated");
  mkdirSync(root, { recursive: true });
  for (const d of projectDirs) mkdirSync(join(root, d), { recursive: true });
  return { db, root, owner: createUser(db, "boot@example.com", "h") };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("adoptExistingProjects", () => {
  it("adopts each directory as a project owned by the bootstrap user", () => {
    const { db, root, owner } = fresh(["run-a", "run-b"]);
    const result = adoptExistingProjects(db, root, owner.id);
    expect(result.adopted.sort()).toEqual(["run-a", "run-b"]);
    expect(listAllProjects(db).map((p) => p.ownerId)).toEqual([owner.id, owner.id]);
  });

  it("is a no-op on a second run — it executes on every boot", () => {
    const { db, root, owner } = fresh(["run-a"]);
    adoptExistingProjects(db, root, owner.id);
    const second = adoptExistingProjects(db, root, owner.id);
    expect(second.adopted).toEqual([]);
    expect(second.skipped).toEqual(["run-a"]);
    expect(listAllProjects(db)).toHaveLength(1);
  });

  it("skips -export directories, which are outputs rather than projects", () => {
    const { db, root, owner } = fresh(["run-a", "run-a-export"]);
    expect(adoptExistingProjects(db, root, owner.id).adopted).toEqual(["run-a"]);
  });

  it("does not adopt files, only directories", () => {
    const { db, root, owner } = fresh(["run-a"]);
    writeFileSync(join(root, "notes.txt"), "x");
    expect(adoptExistingProjects(db, root, owner.id).adopted).toEqual(["run-a"]);
  });

  it("returns empty when the projects root does not exist", () => {
    // A fresh deployment has no generated/ yet; that is not an error.
    const { db, owner } = fresh([]);
    expect(adoptExistingProjects(db, join(tmpdir(), "definitely-not-here-xyz"), owner.id))
      .toEqual({ adopted: [], skipped: [] });
  });

  it("never reassigns a project that already has an owner", () => {
    // The safety property: a second boot with a DIFFERENT bootstrap user must
    // not move existing projects to them.
    const { db, root, owner } = fresh(["run-a"]);
    adoptExistingProjects(db, root, owner.id);
    const other = createUser(db, "other@example.com", "h");
    adoptExistingProjects(db, root, other.id);
    expect(listAllProjects(db)[0]!.ownerId).toBe(owner.id);
  });
});
