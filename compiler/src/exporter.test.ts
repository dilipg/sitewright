import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { OverrideEntry } from "./exporter";
import { exportProject } from "./exporter";
import type { Manifest } from "./manifest";

const fixtureDir = fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));
const brokenDir = fileURLToPath(new URL("../../fixtures/broken/gate3-raw-hex", import.meta.url));

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copies the fixture (sans node_modules/dist) and installs the given overrides. */
function fixtureCopyWithOverrides(overrides: OverrideEntry[]): string {
  const dir = join(tempDir("export-src-"), "project");
  cpSync(fixtureDir, dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.endsWith("dist") && !src.includes(`${join("dist", "")}`),
  });
  writeFileSync(
    join(dir, "overrides", "home.overrides.json"),
    JSON.stringify({ version: 1, route: "/", overrides }, null, 2),
  );
  return dir;
}

const SKIP_ENTRIES = new Set(["node_modules", "dist", "overrides", ".git"]);

/** rel path → content for tree comparison, skipping build/dependency artifacts. */
function treeContents(dir: string, base = dir): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_ENTRIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [key, value] of treeContents(full, base)) out.set(key, value);
    } else {
      out.set(full.slice(base.length).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  }
  return out;
}

function readOut(outDir: string, relPath: string): string {
  return readFileSync(join(outDir, relPath), "utf8");
}

describe("exportProject: identity export", () => {
  const outDir = join(tempDir("export-out-"), "export");

  it("exports the fixture with zero overrides, builds it, and changes nothing", { timeout: 300_000 }, () => {
    const result = exportProject(fixtureDir, { outDir });
    expect(result.outDir).toBe(outDir);
    expect(result.appliedOverrides).toBe(0);

    expect(existsSync(join(outDir, "dist", "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "overrides"))).toBe(false);
    expect(existsSync(join(outDir, "node_modules"))).toBe(false);

    expect(treeContents(outDir)).toEqual(treeContents(fixtureDir));
  });

  it("is idempotent: exporting the export with no overrides produces no diff", { timeout: 60_000 }, () => {
    const secondOut = join(tempDir("export-out2-"), "export");
    exportProject(outDir, { outDir: secondOut, skipBuild: true });
    expect(treeContents(secondOut)).toEqual(treeContents(outDir));
  });
});

describe("exportProject: text channel", () => {
  it("rewrites mock-data literals, never JSX", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero.headline", channel: "text", value: "Ship faster with Acme" },
      { nodeId: "home.hero.cta-primary", channel: "text", value: "Get started free" },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Hero.data.ts");
    expect(mock).toContain('"Ship faster with Acme"');
    expect(mock).not.toContain("Understand your product in minutes");
    expect(mock).toContain('"Get started free"');
    expect(mock).not.toContain('"Start free trial"');

    const section = readOut(outDir, "src/pages/home/sections/Hero.tsx");
    expect(section).not.toContain("Ship faster with Acme");
    expect(section).toContain("{headline}");
  });
});

describe("exportProject: style channel", () => {
  it("compiles token refs to var classes merged last, replacing conflicting utilities", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero", channel: "style", value: { background: "color.semantic.accent" } },
      { nodeId: "home.hero.headline", channel: "style", value: { marginTop: "space.8" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const section = readOut(outDir, "src/pages/home/sections/Hero.tsx");
    // section root: bg utility replaced (Tailwind resolves conflicts by stylesheet
    // order, not class order — the old utility must go), padding kept
    expect(section).toContain("bg-(--color-semantic-accent)");
    expect(section).not.toContain("bg-(--color-semantic-bg) py-(--space-24) bg-");
    expect(section).toContain("py-(--space-24)");
    // headline primitive gains a className, merged last through the cx() seam
    expect(section).toMatch(/nodeId="home\.hero\.headline"[^>]*className="mt-\(--space-8\)"/s);
  });

  it("fails loudly on token-shaped refs that resolve to no token", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero", channel: "style", value: { background: "color.semantic.missing" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(/color\.semantic\.missing/);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("exportProject: layout channel", () => {
  it("compiles free values to arbitrary-value classes", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero.cta-secondary", channel: "layout", value: { width: "480px", alignSelf: "center" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const section = readOut(outDir, "src/pages/home/sections/Hero.tsx");
    expect(section).toMatch(/nodeId="home\.hero\.cta-secondary"[^>]*className="w-\[480px\] self-center"/s);
  });
});

describe("exportProject: visibility channel", () => {
  it("removes the element's JSX and tombstones its manifest entry", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero.subheadline", channel: "visibility", value: true },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    const result = exportProject(source, { outDir, skipBuild: true });

    const section = readOut(outDir, "src/pages/home/sections/Hero.tsx");
    expect(section).not.toContain("home.hero.subheadline");
    expect(section).not.toContain("{subheadline}");

    const manifest = JSON.parse(readOut(outDir, "manifest.json")) as Manifest;
    expect(manifest.nodes["home.hero.subheadline"]?.status).toBe("tombstoned");
    expect(result.tombstoned).toEqual(["home.hero.subheadline"]);
  });
});

describe("exportProject: failure behavior", () => {
  it("a gate-failing project aborts with a report and leaves no output directory", { timeout: 60_000 }, () => {
    const outDir = join(tempDir("export-out-"), "export");
    expect(() => exportProject(brokenDir, { outDir })).toThrow(/gate/i);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses to export into an existing directory", () => {
    const outDir = tempDir("export-exists-");
    expect(() => exportProject(fixtureDir, { outDir })).toThrow(/exists/);
  });

  it("rejects overrides targeting unknown nodes, leaving no output", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.hero.nope", channel: "text", value: "x" },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(/home\.hero\.nope/);
    expect(existsSync(outDir)).toBe(false);
  });
});
