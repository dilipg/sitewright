/**
 * Repairs a generated project's borrowed `node_modules` link (pending item X1).
 *
 * A generated project does not own its dependencies. It carries a directory
 * LINK — a junction on Windows, a symlink on POSIX — pointing at the fixture's
 * `node_modules`, so a run borrows ~400MB instead of copying it. That link
 * stores an ABSOLUTE path, which is the whole problem: it is only valid in the
 * filesystem layout that created it.
 *
 * THE FAILURE THIS FIXES, measured on a real working copy. A project generated
 * inside the container links to `/app/fixtures/acme-landing/node_modules`, which
 * does not exist on the host. Opening it from source then produced:
 *
 *     Failed to resolve import "@tailwindcss/vite" from ".../vite.config.ts"
 *     500 on /__plan and every /preview/** request
 *
 * and the editor blamed it on "its generation is still running" — a confident
 * wrong diagnosis for a project whose files are all present. 6 of 38 projects
 * on that machine were in this state. Renaming the repository root does exactly
 * the same thing to every project at once, which is how this came to be written.
 *
 * WHY NOT A RELATIVE LINK, since that would need no repair at all: a Windows
 * junction does not store one. `mklink /J` resolves its target at creation time
 * and records an absolute path regardless of what it was handed, so "make it
 * relative" is portable only on POSIX — it would fix the container and leave
 * every Windows checkout exactly as broken, while LOOKING like a general fix.
 * Repair works identically on both.
 *
 * THE SUBTLETY THAT MADE THIS A CRASH RATHER THAN A REPAIR: `existsSync`
 * FOLLOWS a link, so a broken link reports `false` — indistinguishable from no
 * link at all. The Python side's `if not target.exists(): link_directory(...)`
 * therefore tried to CREATE a link that was already there, and `mklink` fails on
 * a path that exists. A broken link was an exception, not a self-heal.
 * `lstatSync` is what tells the two apart, because it does not follow.
 */
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { linkDirectory, removeDirectoryLink } from "./exporter.ts";

export type NodeModulesLinkOutcome =
  /** A healthy link, or a real directory. Nothing was touched. */
  | { readonly action: "kept" }
  /** Nothing was there; a link was created. */
  | { readonly action: "linked" }
  /** A link was present but did not resolve; it was replaced. */
  | { readonly action: "repaired"; readonly staleTarget: string }
  /**
   * Repair was needed but impossible — most usefully, the fixture itself is
   * missing. Reported rather than thrown: this runs on the way to spawning a
   * preview, and a project that cannot be linked should produce a clear
   * failure from the thing that actually needs it, not an exception from a
   * best-effort repair.
   */
  | { readonly action: "unavailable"; readonly reason: string };

/**
 * Makes `<projectDir>/node_modules` resolve, or explains why it cannot.
 *
 * Idempotent and safe to call before every spawn: the healthy case is one
 * `lstat` plus one `existsSync`.
 */
export function ensureNodeModulesLink(
  projectDir: string,
  fixtureNodeModules: string,
): NodeModulesLinkOutcome {
  const linkPath = join(projectDir, "node_modules");

  let entry;
  try {
    // NOT `existsSync`: it follows the link, so a dangling one looks absent.
    entry = lstatSync(linkPath);
  } catch {
    entry = undefined;
  }

  if (entry !== undefined && !entry.isSymbolicLink()) {
    // A real directory — a project that owns its own dependencies (`npm
    // install` was run inside it). Never touched: deleting a real
    // node_modules to replace it with a link would throw away an install.
    return { action: "kept" };
  }

  if (entry !== undefined && existsSync(linkPath)) {
    return { action: "kept" };
  }

  if (!existsSync(fixtureNodeModules)) {
    return {
      action: "unavailable",
      reason:
        `the fixture's node_modules (${fixtureNodeModules}) does not exist, so there is ` +
        `nothing to link to — run \`npm install\` at the repository root`,
    };
  }

  if (entry === undefined) {
    try {
      linkDirectory(fixtureNodeModules, linkPath);
      return { action: "linked" };
    } catch (error) {
      return { action: "unavailable", reason: describe(error) };
    }
  }

  // A dangling link: read where it USED to point before removing it, so the
  // log line can name the layout this project came from (`/app/...` for a
  // container-built project) rather than only saying "broken".
  let staleTarget = "(unreadable)";
  try {
    staleTarget = readlinkSync(linkPath);
  } catch {
    // A junction can refuse readlink on some Windows configurations. Not a
    // reason to abandon the repair — the target is diagnostic only.
  }
  try {
    removeDirectoryLink(linkPath);
    linkDirectory(fixtureNodeModules, linkPath);
    return { action: "repaired", staleTarget };
  } catch (error) {
    return { action: "unavailable", reason: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
