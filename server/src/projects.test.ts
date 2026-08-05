// server/src/projects.test.ts
/**
 * A project IS a run directory with one owner (spec, decision 8). The row
 * records who owns which directory and never what is in it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import {
  createProject, findProjectByDirectory, findProjectById, listAllProjects,
  listProjectsByOwner, resolveProjectDirectory,
} from "./projects.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "server-proj-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  return { db, alice: createUser(db, "a@example.com", "h"), bob: createUser(db, "b@example.com", "h") };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("createProject", () => {
  it("stores an owned project and reads it back", () => {
    const { db, alice } = fresh();
    const p = createProject(db, alice.id, "acme-run-1", "Acme");
    expect(findProjectById(db, p.id)).toMatchObject({
      ownerId: alice.id, directory: "acme-run-1", name: "Acme",
    });
  });

  it("refuses a second project on the same directory", () => {
    // Two owners for one directory is the ambiguity the UNIQUE prevents; it
    // also makes adoption idempotent without a caller-side check.
    const { db, alice, bob } = fresh();
    createProject(db, alice.id, "shared", "A");
    expect(() => createProject(db, bob.id, "shared", "B")).toThrow();
  });

  it("refuses an absolute directory", () => {
    // The column holds a path relative to the projects root. An absolute path
    // here is a traversal waiting for a caller that trusts the database.
    const { db, alice } = fresh();
    expect(() => createProject(db, alice.id, "C:\\Windows\\Temp", "bad")).toThrow(/relative/i);
    expect(() => createProject(db, alice.id, "/etc", "bad")).toThrow(/relative/i);
  });

  it("refuses a directory containing a parent-traversal segment", () => {
    const { db, alice } = fresh();
    expect(() => createProject(db, alice.id, "../secrets", "bad")).toThrow(/relative|escape/i);
    expect(() => createProject(db, alice.id, "a/../../b", "bad")).toThrow(/relative|escape/i);
    expect(() => createProject(db, alice.id, "a\\..\\..\\b", "bad")).toThrow(/relative|escape/i);
  });

  it("accepts a directory that merely begins with two dots, and resolveProjectDirectory agrees", () => {
    // "..foo" is a safe sibling-looking name, not a traversal — only a
    // component that IS ".." (or that starts with "..<sep>") is a traversal.
    // createProject and resolveProjectDirectory are two independent guards on
    // the same rule and must accept exactly the same directories.
    const { db, alice } = fresh();
    const p = createProject(db, alice.id, "..foo", "Backup");
    expect(p.directory).toBe("..foo");
    const root = process.platform === "win32" ? "C:\\projects" : "/projects";
    expect(() => resolveProjectDirectory(root, "..foo")).not.toThrow();
    expect(resolveProjectDirectory(root, "..foo")).toBe(join(root, "..foo"));
  });

  it("refuses the bare current-directory segment and its slashed form", () => {
    // The projects root itself is not a project.
    const { db, alice } = fresh();
    expect(() => createProject(db, alice.id, ".", "bad")).toThrow(/relative|escape/i);
    expect(() => createProject(db, alice.id, "./", "bad")).toThrow(/relative|escape/i);
  });

  it("returns null for an unknown id rather than throwing", () => {
    const { db } = fresh();
    expect(findProjectById(db, "nope")).toBeNull();
    expect(findProjectByDirectory(db, "nope")).toBeNull();
  });
});

describe("listProjectsByOwner", () => {
  it("returns only that owner's projects", () => {
    // The query the projects list endpoint uses. If it ever returned everyone's,
    // the leak would be invisible in a single-user test.
    const { db, alice, bob } = fresh();
    createProject(db, alice.id, "a1", "A1");
    createProject(db, alice.id, "a2", "A2");
    createProject(db, bob.id, "b1", "B1");
    expect(listProjectsByOwner(db, alice.id).map((p) => p.directory).sort()).toEqual(["a1", "a2"]);
    expect(listProjectsByOwner(db, bob.id).map((p) => p.directory)).toEqual(["b1"]);
  });

  it("returns an empty array for an owner with none", () => {
    const { db, alice } = fresh();
    expect(listProjectsByOwner(db, alice.id)).toEqual([]);
  });

  it("lists all projects for the operator view", () => {
    const { db, alice, bob } = fresh();
    createProject(db, alice.id, "a1", "A1");
    createProject(db, bob.id, "b1", "B1");
    expect(listAllProjects(db)).toHaveLength(2);
  });
});

describe("schema", () => {
  it("deletes a user's projects when the user is deleted", () => {
    const { db, alice } = fresh();
    createProject(db, alice.id, "a1", "A1");
    db.prepare("DELETE FROM user WHERE id = ?").run(alice.id);
    expect(listAllProjects(db)).toEqual([]);
  });
});

describe("resolveProjectDirectory", () => {
  const root = process.platform === "win32" ? "C:\\projects" : "/projects";

  it("joins a relative directory onto the root", () => {
    expect(resolveProjectDirectory(root, "acme-run-1")).toBe(join(root, "acme-run-1"));
  });

  it("throws for a traversal that would escape the root", () => {
    // Defence in depth: createProject already rejects these, but this function
    // is what slices 4c and 5 hand to a process spawn, and it must not trust a
    // row written by some earlier version of the schema.
    expect(() => resolveProjectDirectory(root, "../outside")).toThrow(/escape/i);
    expect(() => resolveProjectDirectory(root, "a/../../outside")).toThrow(/escape/i);
  });

  it("throws for an absolute directory", () => {
    expect(() => resolveProjectDirectory(root, root)).toThrow(/escape|relative/i);
  });
});
