// server/src/projects.ts
/**
 * Project rows: who owns which run directory.
 *
 * A project IS a run directory (spec, decision 8) — nothing in this system
 * creates a second run for a project, since regen, add-section and the edit
 * agent all mutate in place. Modelling one-to-many would build joins and a
 * "current run" pointer for a cardinality that is always one.
 *
 * The row records ownership, never contents. Generated projects stay on the
 * filesystem exactly as they are.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface Project {
  id: string;
  ownerId: string;
  directory: string;
  name: string;
  createdAt: number;
}

interface Row {
  id: string;
  owner_id: string;
  directory: string;
  name: string;
  created_at: number;
}

function toProject(row: Row): Project {
  return {
    id: row.id,
    ownerId: row.owner_id,
    directory: row.directory,
    name: row.name,
    createdAt: row.created_at,
  };
}

/**
 * `directory` is stored relative to the projects root. Rejecting absolute
 * paths and traversal here means a caller that later joins it onto a root
 * cannot be walked out of that root by a malformed row.
 */
function assertRelativeContained(directory: string): void {
  if (directory === "" || isAbsolute(directory)) {
    throw new Error("project directory must be a relative path inside the projects root");
  }
  const normalized = normalize(directory);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new Error("project directory must not escape the projects root");
  }
}

export function createProject(
  db: DatabaseSync,
  ownerId: string,
  directory: string,
  name: string,
): Project {
  assertRelativeContained(directory);
  const project: Project = {
    id: randomUUID(),
    ownerId,
    directory,
    name,
    createdAt: Date.now(),
  };
  db.prepare(
    "INSERT INTO project (id, owner_id, directory, name, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(project.id, project.ownerId, project.directory, project.name, project.createdAt);
  return project;
}

export function findProjectById(db: DatabaseSync, id: string): Project | null {
  const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toProject(row);
}

export function findProjectByDirectory(db: DatabaseSync, directory: string): Project | null {
  const row = db.prepare("SELECT * FROM project WHERE directory = ?").get(directory) as
    | Row
    | undefined;
  return row === undefined ? null : toProject(row);
}

export function listProjectsByOwner(db: DatabaseSync, ownerId: string): Project[] {
  return (
    db.prepare("SELECT * FROM project WHERE owner_id = ? ORDER BY created_at, directory")
      .all(ownerId) as unknown as Row[]
  ).map(toProject);
}

export function listAllProjects(db: DatabaseSync): Project[] {
  return (
    db.prepare("SELECT * FROM project ORDER BY created_at, directory").all() as unknown as Row[]
  ).map(toProject);
}

/**
 * The only sanctioned way to turn a stored `directory` into a real path.
 * Re-checks containment rather than trusting the row: slices 4c and 5 hand the
 * result to a process spawn, and a row written by an earlier schema version is
 * exactly the input that would not have been validated on the way in.
 */
export function resolveProjectDirectory(projectsRoot: string, directory: string): string {
  const resolved = join(projectsRoot, directory);
  const rel = relative(projectsRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("project directory would escape the projects root");
  }
  return resolved;
}
