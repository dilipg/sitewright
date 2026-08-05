// server/src/adopt.ts
/**
 * First-boot adoption of directories already on disk.
 *
 * There are real acceptance runs in generated/ worth hundreds of MB and worth
 * keeping (spec, Operational requirements), so they are assigned to a named
 * bootstrap user rather than orphaned.
 *
 * This runs on EVERY boot, so it must be idempotent. It is, by construction:
 * project.directory is UNIQUE, and an existing row is skipped rather than
 * updated — so a later boot with a different bootstrap user cannot silently
 * move somebody's projects to them.
 */
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createProject, findProjectByDirectory } from "./projects.ts";

export function adoptExistingProjects(
  db: DatabaseSync,
  projectsRoot: string,
  ownerId: string,
): { adopted: string[]; skipped: string[] } {
  let entries;
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    // A fresh deployment has no projects root yet. Not an error.
    return { adopted: [], skipped: [] };
  }

  const adopted: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    // Export outputs are products of a project, not projects. Adopting them
    // would double every run in the list and give the user two entries that
    // look the same.
    if (!entry.isDirectory() || entry.name.endsWith("-export")) continue;
    if (findProjectByDirectory(db, entry.name) !== null) {
      skipped.push(entry.name);
      continue;
    }
    createProject(db, ownerId, entry.name, entry.name);
    adopted.push(entry.name);
  }
  return { adopted, skipped };
}
