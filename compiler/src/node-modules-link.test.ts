/**
 * X1: a generated project's borrowed `node_modules` link breaks whenever the
 * filesystem layout changes under it — a container-built project opened on the
 * host, or a repository root that got renamed. These pin the repair.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { linkDirectory } from "./exporter.ts";
import { fixtureDir, fixtureNodeModules } from "./fixture-path.ts";
import { ensureNodeModulesLink } from "./node-modules-link.ts";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "nm-link-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in fixture node_modules with something identifiable inside. */
function fakeFixture(root: string): string {
  const nm = join(root, "fixture-node_modules");
  mkdirSync(join(nm, "@tailwindcss", "vite"), { recursive: true });
  writeFileSync(join(nm, "@tailwindcss", "vite", "package.json"), "{}");
  return nm;
}

function resolves(projectDir: string): boolean {
  // The only question that matters: can the preview child resolve an import
  // through this link?
  return existsSync(join(projectDir, "node_modules", "@tailwindcss", "vite", "package.json"));
}

describe("ensureNodeModulesLink", () => {
  it("links a project that has none", () => {
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(project);

    expect(ensureNodeModulesLink(project, fixture)).toEqual({ action: "linked" });
    expect(resolves(project)).toBe(true);
  });

  it("REPAIRS a link pointing where the container put it — the X1 case", () => {
    // Exactly the measured state: a link to /app/fixtures/... on a host where
    // that path does not exist. 6 of 38 projects on the reporting machine.
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(project);
    linkDirectory(join(root, "app", "fixtures", "acme-landing", "node_modules"), join(project, "node_modules"));
    expect(resolves(project)).toBe(false); // premise: genuinely broken first

    const outcome = ensureNodeModulesLink(project, fixture);
    expect(outcome.action).toBe("repaired");
    expect(resolves(project)).toBe(true);
  });

  it("names the stale target, so a log line says which layout it came from", () => {
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(project);
    const stale = join(root, "gone", "node_modules");
    linkDirectory(stale, join(project, "node_modules"));

    const outcome = ensureNodeModulesLink(project, fixture);
    expect(outcome.action).toBe("repaired");
    if (outcome.action === "repaired") expect(outcome.staleTarget).toContain("gone");
  });

  it("leaves a HEALTHY link alone", () => {
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(project);
    linkDirectory(fixture, join(project, "node_modules"));

    expect(ensureNodeModulesLink(project, fixture)).toEqual({ action: "kept" });
    expect(resolves(project)).toBe(true);
  });

  it("NEVER replaces a real node_modules directory", () => {
    // A project that owns its dependencies (someone ran `npm install` in it).
    // Deleting that to substitute a link would throw away a real install.
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(join(project, "node_modules", "something-installed"), { recursive: true });

    expect(ensureNodeModulesLink(project, fixture)).toEqual({ action: "kept" });
    expect(existsSync(join(project, "node_modules", "something-installed"))).toBe(true);
    expect(lstatSync(join(project, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("reports unavailable — never throws — when the fixture itself is missing", () => {
    // This runs on the way to spawning a preview. An exception from a
    // best-effort repair would replace the real, actionable failure.
    const root = scratch();
    const project = join(root, "project");
    mkdirSync(project);

    const outcome = ensureNodeModulesLink(project, join(root, "no-such-fixture"));
    expect(outcome.action).toBe("unavailable");
    if (outcome.action === "unavailable") expect(outcome.reason).toContain("npm install");
  });

  it("is idempotent — a second call after a repair changes nothing", () => {
    const root = scratch();
    const fixture = fakeFixture(root);
    const project = join(root, "project");
    mkdirSync(project);
    linkDirectory(join(root, "gone", "node_modules"), join(project, "node_modules"));

    expect(ensureNodeModulesLink(project, fixture).action).toBe("repaired");
    expect(ensureNodeModulesLink(project, fixture)).toEqual({ action: "kept" });
    expect(resolves(project)).toBe(true);
  });
});

/**
 * A PREMISE GUARD for everything above. The repair links a project at
 * `fixtureNodeModules()`; if that function pointed somewhere wrong, every test
 * above would still pass (they pass their own fake fixture in) while the
 * production path silently linked projects at nothing.
 */
describe("fixture-path", () => {
  it("resolves the real fixture, from this module's location rather than cwd", () => {
    // Relative to import.meta.url on purpose: the callers run from the repo
    // root, from server/, and from inside a generated project, and the repo
    // root itself can be renamed.
    expect(existsSync(fixtureDir())).toBe(true);
    expect(existsSync(fixtureNodeModules())).toBe(true);
  });

  it("points at a node_modules that can actually satisfy a generated project", () => {
    // `@tailwindcss/vite` specifically: it is imported by every generated
    // project's own vite.config.ts, and it is the exact specifier the X1
    // failure reported as unresolvable.
    expect(existsSync(join(fixtureNodeModules(), "@tailwindcss", "vite"))).toBe(true);
  });
});
