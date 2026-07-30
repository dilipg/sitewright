import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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

    // Every source file is byte-identical to the fixture; the only addition
    // is the generated handover doc (6.2). With zero overrides there is
    // nothing to archive, so no overrides-archive/ either.
    expect(existsSync(join(outDir, "HANDOVER.md"))).toBe(true);
    expect(existsSync(join(outDir, "overrides-archive"))).toBe(false);
    const exported = treeContents(outDir);
    expect(exported.has("/HANDOVER.md")).toBe(true);
    exported.delete("/HANDOVER.md");
    expect(exported).toEqual(treeContents(fixtureDir));
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

describe("exportProject: list-item overrides", () => {
  it("text: rewrites the matching array element's field, leaving sibling items untouched", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-starter.name", channel: "text", value: "Starter Plus" },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    expect(mock).toContain('"Starter Plus"');
    expect(mock).not.toContain('"Starter"');
    expect(mock).toContain('"Growth"'); // sibling tier untouched
    expect(mock).toContain('"Scale"');
  });

  it("visibility on a list item's own root: sets hidden on that item's mock entry only", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.testimonials.testimonial-elena", channel: "visibility", value: true },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    const result = exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Testimonials.data.ts");
    expect(mock).toMatch(/key:\s*"elena"[\s\S]*?hidden:\s*true/);
    const priyaBlock = mock.split('key: "priya"')[1]?.split('key: "marcus"')[0] ?? "";
    expect(priyaBlock).not.toContain("hidden");
    expect(result.tombstoned).toEqual([]); // list items have no manifest entry of their own to tombstone
  });

  it("visibility on a list item's child: sets childHidden keyed by the child suffix", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth.badge", channel: "visibility", value: true },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    expect(mock).toMatch(/key:\s*"growth"[\s\S]*?childHidden:\s*\{\s*"badge":\s*true/);
  });

  it("style on a list item's own root: merges a compiled utility class into that item's className field", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth", channel: "style", value: { background: "color.semantic.accent" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    expect(mock).toMatch(/key:\s*"growth"[\s\S]*?className:\s*"bg-\(--color-semantic-accent\)!"/);
  });

  it("layout on a list item's child: merges a compiled utility class into childClassNames keyed by suffix", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.capabilities.feature-realtime-sync.title", channel: "layout", value: { width: "480px" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Capabilities.data.ts");
    expect(mock).toMatch(/key:\s*"realtime-sync"[\s\S]*?childClassNames:\s*\{\s*"title":\s*"w-\[480px\]!"/);
  });

  it("a second style override on the same item merges rather than replacing the first (different properties)", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth", channel: "style", value: { background: "color.semantic.accent" } },
      { nodeId: "home.pricing.tier-growth", channel: "layout", value: { width: "480px" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    expect(mock).toMatch(/key:\s*"growth"[\s\S]*?className:\s*"bg-\(--color-semantic-accent\)! w-\[480px\]!"/);
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

describe("exportProject: handover package (6.2)", () => {
  it("writes HANDOVER.md naming the integration seam and the off-scale edit", () => {
    const projectDir = fixtureCopyWithOverrides([
      { nodeId: "home.hero.headline", channel: "style", value: { color: "#ff5500" } },
    ]);
    const outDir = join(tempDir("export-handover-"), "export");
    const result = exportProject(projectDir, { outDir, skipBuild: true });

    expect(result.handover).toBe(readOut(outDir, "HANDOVER.md"));
    // the fixture's contact form is the one interactive seam
    expect(result.integrationCount).toBe(1);
    expect(result.handover).toContain("onSubmit");
    // the #ff5500 edit is off-scale; it must be surfaced, not hidden
    expect(result.offScaleCount).toBe(1);
    expect(result.handover).toContain("#ff5500");
  });

  it("archives the override files that carried edits, and says they are a record", () => {
    const projectDir = fixtureCopyWithOverrides([
      { nodeId: "home.hero.headline", channel: "text", value: "Archived" },
    ]);
    const outDir = join(tempDir("export-archive-"), "export");
    exportProject(projectDir, { outDir, skipBuild: true });

    const archived = JSON.parse(
      readOut(outDir, join("overrides-archive", "home.overrides.json")),
    ) as { overrides: OverrideEntry[] };
    expect(archived.overrides).toHaveLength(1);
    expect(archived.overrides[0]!.value).toBe("Archived");
    expect(readOut(outDir, join("overrides-archive", "README.md"))).toContain("record");
    // untouched routes contributed nothing
    expect(existsSync(join(outDir, "overrides-archive", "about.overrides.json"))).toBe(false);
  });

  it("leaves the source project's overrides intact so it stays editable and re-exportable", () => {
    const projectDir = fixtureCopyWithOverrides([
      { nodeId: "home.hero.headline", channel: "text", value: "Still editable" },
    ]);
    const before = readFileSync(join(projectDir, "overrides", "home.overrides.json"), "utf8");

    exportProject(projectDir, { outDir: join(tempDir("export-repeat-a-"), "export"), skipBuild: true });
    expect(readFileSync(join(projectDir, "overrides", "home.overrides.json"), "utf8")).toBe(before);

    // and a second export from the same source still applies the same edit
    const secondOut = join(tempDir("export-repeat-b-"), "export");
    const second = exportProject(projectDir, { outDir: secondOut, skipBuild: true });
    expect(second.appliedOverrides).toBe(1);
    expect(readOut(secondOut, join("src", "pages", "home", "mock", "Hero.data.ts"))).toContain(
      "Still editable",
    );
  });

  it("omits generator state from the package but keeps what describes the code", () => {
    const projectDir = fixtureCopyWithOverrides([]);
    // plan/ is orchestrator state (brief, siteplan, approval flag) — residue
    // to a receiving developer, so it must not reach the handover.
    mkdirSync(join(projectDir, "plan"), { recursive: true });
    writeFileSync(join(projectDir, "plan", "brief.json"), '{"brand":{}}');
    const outDir = join(tempDir("export-skip-plan-"), "export");
    const result = exportProject(projectDir, { outDir, skipBuild: true });

    expect(existsSync(join(outDir, "plan"))).toBe(false);
    expect(result.files.some((file) => file.startsWith("plan/"))).toBe(false);
    // ...while the node registry and primitive inventory DO ship: they
    // describe the delivered code and keep the export re-importable (PRD 6).
    expect(result.files).toContain("manifest.json");
  });

  it("lists packaged files, excluding dependencies and build output", () => {
    const projectDir = fixtureCopyWithOverrides([]);
    const outDir = join(tempDir("export-files-"), "export");
    const result = exportProject(projectDir, { outDir, skipBuild: true });

    expect(result.files).toContain("HANDOVER.md");
    expect(result.files).toContain("src/pages/home/sections/Hero.tsx");
    expect(result.files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(result.files.some((file) => file.startsWith("dist/"))).toBe(false);
    expect([...result.files]).toEqual([...result.files].sort());
  });

  it("writes a zip whose bytes are identical across repeat exports of the same project", () => {
    const projectDir = fixtureCopyWithOverrides([
      { nodeId: "home.hero.headline", channel: "text", value: "Deterministic" },
    ]);
    const zipDir = tempDir("export-zips-");

    const firstZip = join(zipDir, "first.zip");
    exportProject(projectDir, {
      outDir: join(tempDir("export-zip-a-"), "export"),
      skipBuild: true,
      zipPath: firstZip,
    });
    const secondZip = join(zipDir, "second.zip");
    exportProject(projectDir, {
      outDir: join(tempDir("export-zip-b-"), "export"),
      skipBuild: true,
      zipPath: secondZip,
    });

    expect(readFileSync(firstZip).equals(readFileSync(secondZip))).toBe(true);
  });

  it("refuses a zip target inside the export directory", () => {
    const projectDir = fixtureCopyWithOverrides([]);
    const outDir = join(tempDir("export-zip-guard-"), "export");
    expect(() =>
      exportProject(projectDir, { outDir, skipBuild: true, zipPath: join(outDir, "package.zip") }),
    ).toThrow(/outside the export directory/);
    // failed export leaves nothing behind (contract 7.4)
    expect(existsSync(outDir)).toBe(false);
  });
});

/**
 * Argument parsing only. These run the CLI against a project with no
 * node_modules, so the verification build cannot succeed — irrelevant here:
 * what is being tested is that the positional arguments survive flag
 * parsing, distinguishable from a parse failure by exit code 2 + the usage
 * banner. Zip writing is covered by the exporter unit test above; the real
 * CLI-with-build path runs in the invariant suite.
 */
describe("export CLI argument handling", () => {
  const cliPath = fileURLToPath(new URL("../scripts/export.ts", import.meta.url));

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("node", [cliPath, ...args], { encoding: "utf8", timeout: 120_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it(
    "accepts a plain non-zip invocation (regression: --zip index math ate the projectDir)",
    { timeout: 120_000 },
    () => {
      const projectDir = fixtureCopyWithOverrides([]);
      const result = runCli([projectDir, join(tempDir("cli-plain-"), "export"), "--clean"]);
      expect(result.status).not.toBe(2);
      expect(result.stderr).not.toContain("Usage:");
    },
  );

  it("accepts --zip <path> without losing the positional arguments", { timeout: 120_000 }, () => {
    const projectDir = fixtureCopyWithOverrides([]);
    const result = runCli([
      projectDir,
      join(tempDir("cli-zip-"), "export"),
      "--clean",
      "--zip",
      join(tempDir("cli-zip-out-"), "handover.zip"),
    ]);
    expect(result.status).not.toBe(2);
    expect(result.stderr).not.toContain("Usage:");
  });

  it("rejects --zip without a path rather than swallowing the next flag as one", () => {
    const result = runCli(["src", "out", "--zip", "--clean"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--zip requires a path");
  });

  it("still reports missing positional arguments", () => {
    const result = runCli(["only-one-arg"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});
