import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { OverrideEntry } from "./exporter";
import { exportProject, linkDirectory, removeDirectoryLink } from "./exporter";
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
    // headline primitive gains a className, merged last through the cx() seam.
    // Forced important ("!"): Heading's own base classes (a shared primitive,
    // not this instance's className) always set a default color, so without a
    // forced tiebreaker Tailwind's stylesheet order -- not source order --
    // would decide the winner (same reasoning as the list-item path below).
    expect(section).toMatch(/nodeId="home\.hero\.headline"[^>]*className="mt-\(--space-8\)!"/s);
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
    expect(section).toMatch(/nodeId="home\.hero\.cta-secondary"[^>]*className="w-\[480px\]! self-center!"/s);
  });

  it("replaces a same-category KEYWORD utility (no ( or [), not just merges alongside it", { timeout: 60_000 }, () => {
    // Regression: utilityCategory's keyword fallback (`cls.replace(/-[a-z0-9]+$/, "")`)
    // anchors on the end of the string. Before this fix, the trailing "!" this
    // channel always appends sat after that anchor and defeated the match, so
    // conflictsWith("text-center", "text-left!") came back false -- the old
    // utility was never removed, and export shipped BOTH "text-center" and
    // "text-left!" on the same element. home.faq.heading is a literal node
    // whose OWN className already carries a keyword utility ("text-center",
    // set directly in Faq.tsx) rather than one hidden inside a primitive, so
    // this exercises mergeClassName's string-level removal specifically.
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.faq.heading", channel: "layout", value: { textAlign: "left" } },
    ]);
    const outDir = join(tempDir("export-out-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const section = readOut(outDir, "src/pages/home/sections/Faq.tsx");
    expect(section).toMatch(/nodeId="home\.faq\.heading"[^>]*className="text-left!"/s);
    expect(section).not.toContain("text-center");
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

  it("resolves a DERIVED list back to its mock-data prop", { timeout: 60_000 }, () => {
    // A section may filter before mapping — `const visible = items.filter(...)`
    // then `visible.map(...)` — which is behaviourally identical to the
    // `if (item.hidden) return null` form the templates teach, and is what a
    // model reasonably writes. The compiler resolved the MAPPED identifier, so
    // it went looking for a `visible` array in mock data that only exports
    // `items`, and every list-item override on such a section failed the export.
    // Observed live on a generated BuilderCanvas (`visibleFields`).
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.capabilities.feature-realtime-sync.title", channel: "layout", value: { width: "480px" } },
    ]);
    const sectionPath = join(source, "src", "pages", "home", "sections", "Capabilities.tsx");
    const derived = readFileSync(sectionPath, "utf8").replace(
      "{features.map((feature) => {",
      "{visibleFeatures.map((feature) => {",
    );
    expect(derived, "fixture no longer maps `features` directly; update this test").toContain(
      "visibleFeatures.map",
    );
    writeFileSync(
      sectionPath,
      derived.replace(
        "  return (",
        "  const visibleFeatures = features.filter((feature) => feature.hidden !== true); return (",
      ),
    );

    const outDir = join(tempDir("export-derived-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Capabilities.data.ts");
    expect(mock).toMatch(/key:\s*"realtime-sync"[\s\S]*?childClassNames:\s*\{\s*"title":\s*"w-\[480px\]!"/);
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

/**
 * THE CASE THE LIST-ITEM SUITE ABOVE COULD NOT CATCH, and the reason a
 * preview ≠ handover defect shipped.
 *
 * There is exactly one list-item TEXT test above, and it targets
 * `home.pricing.tier-starter.name` — the single shape in the whole project
 * where a node id's last segment happens to EQUAL the mock field it feeds
 * (`.name` -> `name`). The exporter resolved the field to rewrite FROM THAT
 * SUFFIX, so it passed for the one tested shape and failed for every other
 * shape the shipped archetype templates actually use:
 *
 *   `.badge` -> `badgeLabel`   (pricing-tiers, product-card-grid)
 *   `.cta`   -> `ctaLabel`     (pricing-tiers, and the fixture below)
 *   `.image` -> `imageSrc`     (cart-drawer, product-card-grid)
 *   `.photo` -> `photoSrc`     (team-grid)
 *
 * So an ordinary double-click copy edit on a card's badge — and an image
 * replace on a card's image (PRD 3.5: the TEXT channel with `key: "src"`) —
 * applied in the preview and then made the export fail PERMANENTLY with
 * `Mock field "badge" ... is not a string literal`. Naming a field the user
 * never saw, on an edit they watched succeed.
 *
 * The field must be resolved from SOURCE — which mock field feeds this node's
 * text child, or feeds the attribute named by `override.key` — exactly as the
 * literal-node path (`applyTextOverride`) has always resolved it. Never from
 * the id, and never by guessing candidate field names: a wrong-but-plausible
 * rewrite ships silently into handover, which is worse than a loud refusal.
 */
describe("exportProject: a list item whose mock field is not named after its id suffix", () => {
  it("plain copy edit on `.badge` rewrites `badgeLabel`, leaving the JSX seam intact", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth.badge", channel: "text", value: "Best value" },
    ]);
    // premise: the suffix and the field genuinely differ, or the case is vacuous
    expect(readOut(source, "src/pages/home/sections/Pricing.tsx")).toContain("{tier.badgeLabel}");

    const outDir = join(tempDir("export-suffix-badge-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    expect(mock).toContain('badgeLabel: "Best value"');
    expect(mock).not.toContain("Most popular");
    // no field literally named after the suffix was invented
    expect(mock).not.toContain("badge:");
    // sibling tiers untouched, and the props seam preserved
    expect(mock).toContain('"Starter"');
    expect(readOut(outDir, "src/pages/home/sections/Pricing.tsx")).toContain("{tier.badgeLabel}");
  });

  it("`key` picks between two differently-named fields on the SAME node (`.cta`: ctaLabel vs ctaHref)", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-starter.cta", channel: "text", value: "Try it free" },
      { nodeId: "home.pricing.tier-growth.cta", channel: "text", key: "href", value: "/about" },
    ]);
    const outDir = join(tempDir("export-suffix-cta-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Pricing.data.ts");
    // the unkeyed edit hit the text child's field...
    expect(mock).toMatch(/key:\s*"starter"[\s\S]*?ctaLabel:\s*"Try it free"/);
    expect(mock).not.toContain('"Start free"');
    // ...and the keyed one hit the attribute's field on the OTHER item only
    expect(mock).toMatch(/key:\s*"growth"[\s\S]*?ctaHref:\s*"\/about"/);
    expect(mock).toMatch(/key:\s*"starter"[\s\S]*?ctaHref:\s*"\/"/);
    expect(mock).toMatch(/key:\s*"growth"[\s\S]*?ctaLabel:\s*"Start trial"/);
  });

  it("image replace (key `src`) on a list item's image rewrites `avatarSrc`", { timeout: 60_000 }, () => {
    const source = fixtureCopyWithOverrides([
      {
        nodeId: "home.testimonials.testimonial-elena.avatar",
        channel: "text",
        key: "src",
        value: "https://cdn.example.com/new-avatar.jpg",
      },
    ]);
    addListItemAvatar(source);

    const outDir = join(tempDir("export-suffix-avatar-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/home/mock/Testimonials.data.ts");
    expect(mock).toContain('avatarSrc: "https://cdn.example.com/new-avatar.jpg"');
    // the targeted item only, and its alt sibling untouched
    expect(mock).toMatch(/key:\s*"elena"[\s\S]*?avatarSrc:\s*"https:\/\/cdn\.example\.com\/new-avatar\.jpg"/);
    expect(mock).toContain("avatars/priya.jpg");
    expect(mock).toContain("avatars/marcus.jpg");
    expect(mock).toMatch(/key:\s*"elena"[\s\S]*?avatarAlt:\s*"Portrait of elena"/);
    // the swap landed in data, never in JSX (contract 7.1's props seam)
    expect(readOut(outDir, "src/pages/home/sections/Testimonials.tsx")).toContain("src={testimonial.avatarSrc}");
  });

  it("still refuses when no mock field feeds the node, rather than guessing one", { timeout: 60_000 }, () => {
    // `formatMoney(item.price)`-style wrappers, a hoisted const, a typo'd key:
    // all must fail loudly. Here the named attribute exists on no element.
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth.badge", channel: "text", key: "src", value: "x" },
    ]);
    const outDir = join(tempDir("export-suffix-refuse-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(/no "src" attribute/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses a node inside the map that renders a SECTION-level prop, not the item's own field", { timeout: 60_000 }, () => {
    // The reason resolution is anchored to the map parameter and not merely
    // "the field the expression names". Here a per-item node renders the
    // section's shared `description` prop. Both the suffix (`description`) and
    // the bare expression (`description`) collide with a field the tier DOES
    // have — so a resolver that trusted either would rewrite `tier.description`,
    // a field this component no longer renders: the preview shows the shared
    // section text edited, the export writes to a dead per-item field, and
    // nothing anywhere reports a problem. A silent wrong rewrite is worse than
    // a refusal, because it ships into handover.
    const source = fixtureCopyWithOverrides([
      { nodeId: "home.pricing.tier-growth.description", channel: "text", value: "Rewritten" },
    ]);
    const sectionPath = join(source, "src", "pages", "home", "sections", "Pricing.tsx");
    const rewired = readFileSync(sectionPath, "utf8").replace("{tier.description}", "{description}");
    // premise: the fixture still renders the item's own field there
    expect(rewired, "fixture's Pricing no longer renders {tier.description}").not.toContain("{tier.description}");
    writeFileSync(sectionPath, rewired);

    const outDir = join(tempDir("export-suffix-shared-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(
      /is not a plain "tier\.<field>" reference on the mapped item/,
    );
    expect(existsSync(outDir)).toBe(false);
  });
});

/**
 * Adds the list-item IMAGE shape the fixture has no instance of but four
 * shipped templates do (`cart-drawer`/`product-card-grid`: `.image` ->
 * `imageSrc`; `team-grid`: `.photo` -> `photoSrc`): a mapped item's child
 * whose id suffix differs from the mock field feeding its `src`.
 *
 * Mutating the COPY, not `fixtures/acme-landing` itself — the fixture is the
 * invariant suite's subject and its rendered pixels are load-bearing there
 * (see the reorder case in decisions.md's 2026-08-02 rows). Same technique the
 * "DERIVED list" case above uses for the same reason.
 */
function addListItemAvatar(projectDir: string): void {
  const sectionPath = join(projectDir, "src", "pages", "home", "sections", "Testimonials.tsx");
  const section = readFileSync(sectionPath, "utf8")
    .replace(
      'import Heading from "../../../primitives/Heading";',
      'import Heading from "../../../primitives/Heading";\nimport Image from "../../../primitives/Image";',
    )
    .replace("  quote: string;", "  avatarSrc: string;\n  avatarAlt: string;\n  quote: string;")
    .replace(
      "                {testimonial.childHidden?.quote !== true && (",
      "                {testimonial.childHidden?.avatar !== true && (\n" +
        "                  <Image\n" +
        "                    nodeId={`${testimonialId}.avatar`}\n" +
        "                    src={testimonial.avatarSrc}\n" +
        "                    alt={testimonial.avatarAlt}\n" +
        "                    className={testimonial.childClassNames?.avatar}\n" +
        "                  />\n" +
        "                )}\n" +
        "                {testimonial.childHidden?.quote !== true && (",
    );
  // premise: every replacement landed, or the case would test nothing
  expect(section, "fixture's Testimonials no longer has the shape this case mutates").toContain(
    "src={testimonial.avatarSrc}",
  );
  expect(section).toContain("avatarSrc: string;");
  expect(section).toContain('import Image from "../../../primitives/Image";');
  writeFileSync(sectionPath, section);

  const dataPath = join(projectDir, "src", "pages", "home", "mock", "Testimonials.data.ts");
  const data = readFileSync(dataPath, "utf8").replace(
    /key: "(\w+)",/g,
    (_match, key: string) =>
      `key: "${key}",\n      avatarSrc: "https://images.acme.example/avatars/${key}.jpg",\n` +
      `      avatarAlt: "Portrait of ${key}",`,
  );
  expect(data.match(/avatarSrc:/g)).toHaveLength(3);
  writeFileSync(dataPath, data);

  // gate 4 / validateOverrides: a list item's id must still be a registered,
  // active manifest node, pattern-attached like its siblings.
  const manifestPath = join(projectDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  for (const key of ["priya", "marcus", "elena"]) {
    manifest.nodes[`home.testimonials.testimonial-${key}.avatar`] = {
      route: "/",
      file: "src/pages/home/sections/Testimonials.tsx",
      component: "Testimonials",
      element: "Image",
      editable: ["text", "style", "layout", "visibility"],
      status: "active",
    };
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

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

describe("exportProject: image replace (PRD 3.5, milestone 7.7)", () => {
  it("rewrites the mock-data field feeding the src attribute, not the JSX", () => {
    const source = fixtureCopyWithOverrides([]);
    writeFileSync(
      join(source, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          {
            nodeId: "about.intro.portrait",
            channel: "text",
            key: "src",
            value: "https://cdn.example.com/new-portrait.jpg",
          },
        ],
      }),
    );
    const outDir = join(tempDir("export-image-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    // the swap lands in mock data — the props seam is preserved
    const mock = readOut(outDir, "src/pages/about/mock/AboutIntro.data.ts");
    expect(mock).toContain("https://cdn.example.com/new-portrait.jpg");
    expect(mock).not.toContain("images.acme.example/team/founders.jpg");

    // ...and the component still reads it through the prop, untouched
    const section = readOut(outDir, "src/pages/about/sections/AboutIntro.tsx");
    expect(section).toContain("src={portraitSrc}");
    expect(section).not.toContain("cdn.example.com");
  });

  it("leaves the node's text alone — a keyed override is not a copy edit", () => {
    const source = fixtureCopyWithOverrides([]);
    writeFileSync(
      join(source, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          { nodeId: "about.intro.portrait", channel: "text", key: "alt", value: "A new caption" },
        ],
      }),
    );
    const outDir = join(tempDir("export-image-alt-"), "export");
    exportProject(source, { outDir, skipBuild: true });

    const mock = readOut(outDir, "src/pages/about/mock/AboutIntro.data.ts");
    expect(mock).toContain('portraitAlt: "A new caption"');
    // the sibling src field is untouched
    expect(mock).toContain("images.acme.example/team/founders.jpg");
  });

  it("fails loudly when the named attribute is not bound to a prop", () => {
    const source = fixtureCopyWithOverrides([]);
    writeFileSync(
      join(source, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          { nodeId: "about.intro.portrait", channel: "text", key: "nope", value: "x" },
        ],
      }),
    );
    const outDir = join(tempDir("export-image-bad-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(/no "nope" attribute/);
    expect(existsSync(outDir)).toBe(false);
  });
});

/**
 * THE TEST THIS SUITE WAS MISSING, and the reason a contract-level regression got
 * all the way to a pre-merge review with every gate and all 1,000-odd tests green.
 *
 * Contract 7.1 defines the text channel as rewriting the mock data LITERAL, and
 * both implementations resolve the leaf via `.asKind(SyntaxKind.StringLiteral)`.
 * A generation prompt was then changed to hoist every image's data URI into one
 * `const PLACEHOLDER_IMAGE = "…"` per mock file and reference it — an
 * `Identifier`, not a `StringLiteral` — which turned image replace (PRD 3.5,
 * feature 7.7: the text channel with key `src`) into a permanent export failure
 * on every generated storefront.
 *
 * Nothing caught it because THE ONLY PROJECT THIS SUITE EVER EXPORTS IS
 * `fixtures/acme-landing`, whose mock fields are all literals — so the export
 * path had never once seen an identifier. That is the same fixture-vs-generated-
 * shape gap that produced 5.4's list-item override bug and 5.5's `generic-section`
 * contract violations. These two cases close it by exporting a project shaped the
 * way generation shapes them, on BOTH override paths.
 *
 * They pin a refusal, deliberately. The fix belongs on the generator side (the
 * prompt now forbids hoisting, and `placeholder_image.inline_hoisted_string_consts`
 * inlines it back if the model does it anyway); teaching the exporter to resolve
 * identifiers was rejected, because one const feeds many items and the
 * deterministic spine is what guarantees preview = handover. If that decision is
 * ever revisited, these are the tests to change on purpose.
 */
describe("exportProject: a mock field bound to an identifier (contract 7.1)", () => {
  /** The exact shape the generator briefly taught: one hoisted const, referenced. */
  function hoistMockField(projectDir: string): void {
    const mockPath = join(projectDir, "src", "pages", "about", "mock", "AboutIntro.data.ts");
    const original = readFileSync(mockPath, "utf8");
    writeFileSync(
      mockPath,
      original.replace(
        'portraitSrc: "https://images.acme.example/team/founders.jpg",',
        "portraitSrc: PLACEHOLDER_IMAGE,",
      ).replace(
        "export const aboutIntroData",
        'const PLACEHOLDER_IMAGE = "data:image/svg+xml,%3Csvg%20/%3E";\n\nexport const aboutIntroData',
      ),
    );
  }

  it("refuses the keyed image-replace override instead of silently shipping the old image", () => {
    const source = fixtureCopyWithOverrides([]);
    hoistMockField(source);
    // premise: without this the file is a literal and the case is vacuous
    expect(readOut(source, "src/pages/about/mock/AboutIntro.data.ts")).toContain(
      "portraitSrc: PLACEHOLDER_IMAGE,",
    );

    writeFileSync(
      join(source, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          {
            nodeId: "about.intro.portrait",
            channel: "text",
            key: "src",
            value: "https://cdn.example.com/new-portrait.jpg",
          },
        ],
      }),
    );
    const outDir = join(tempDir("export-hoisted-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(
      /"portraitSrc" for node "about\.intro\.portrait" is not a string literal/,
    );
    // and nothing half-written is left behind for a retry to trip over
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses a plain copy edit on a hoisted field too — the defect is not image-specific", () => {
    const source = fixtureCopyWithOverrides([]);
    const mockPath = join(source, "src", "pages", "about", "mock", "AboutIntro.data.ts");
    writeFileSync(
      mockPath,
      readFileSync(mockPath, "utf8")
        .replace(/heading: ".*",/, "heading: SHARED_HEADING,")
        .replace(
          "export const aboutIntroData",
          'const SHARED_HEADING = "Built by analysts, for analysts";\n\nexport const aboutIntroData',
        ),
    );
    writeFileSync(
      join(source, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [{ nodeId: "about.intro.heading", channel: "text", value: "A new heading" }],
      }),
    );
    const outDir = join(tempDir("export-hoisted-text-"), "export");
    expect(() => exportProject(source, { outDir, skipBuild: true })).toThrow(
      /is not a string literal/,
    );
  });
});

describe("exportProject: orphan page directories", () => {
  it("drops a page directory with no route pointing at it", { timeout: 60_000 }, () => {
    // The Design System Agent writes a dev-only primitive gallery to
    // src/pages/home/index.tsx so there is something to look at while no
    // sections exist (5.2). When the plan has no `home` route, nothing cleans
    // it up and the handover ships an unreachable page importing every
    // primitive. Filtering on routes.ts catches any orphan, not just that one.
    const dir = fixtureCopyWithOverrides([]);
    const orphan = join(dir, "src", "pages", "leftover-gallery");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(
      join(orphan, "index.tsx"),
      "export default function LeftoverGalleryPage() { return <div />; }",
    );
    const outDir = join(tempDir("export-orphan-"), "export");
    const result = exportProject(dir, { outDir, skipBuild: true });

    expect(existsSync(join(outDir, "src", "pages", "leftover-gallery"))).toBe(false);
    expect(result.files.some((file) => file.includes("leftover-gallery"))).toBe(false);
    // the routed pages are untouched
    expect(existsSync(join(outDir, "src", "pages", "home"))).toBe(true);
    expect(existsSync(join(outDir, "src", "pages", "about"))).toBe(true);
  });

  it("keeps every page when routes.ts cannot be read, rather than dropping files", { timeout: 60_000 }, () => {
    // Failing open is the only safe direction: shipping one extra directory is
    // a blemish, deleting a real page because a regex missed is data loss.
    const dir = fixtureCopyWithOverrides([]);
    rmSync(join(dir, "src", "shell", "routes.ts"));
    const outDir = join(tempDir("export-noroutes-"), "export");
    // gates will fail without routes.ts, so assert the copy decision directly
    expect(() => exportProject(dir, { outDir, skipBuild: true })).toThrow();
  });
});

describe("exportProject: section reorder (PRD 3.3, milestone 7.5)", () => {
  /** Home's sections in source order, per the fixture's index.tsx. */
  const HOME_ORDER = [
    "home.hero",
    "home.capabilities",
    "home.pricing",
    "home.testimonials",
    "home.faq",
    "home.cta-band",
  ];

  function withSectionOrder(order: string[]): string {
    const dir = fixtureCopyWithOverrides([]);
    writeFileSync(
      join(dir, "overrides", "home.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/",
        overrides: [{ nodeId: "home", channel: "sectionOrder", value: order }],
      }),
    );
    return dir;
  }

  function renderedOrder(indexSource: string): string[] {
    return [...indexSource.matchAll(/nodeId="([^"]+)"/g)].map((match) => match[1]!);
  }

  it("reorders the page's JSX children, not the DOM", () => {
    const moved = [HOME_ORDER[5]!, ...HOME_ORDER.slice(0, 5)]; // cta-band to the top
    const outDir = join(tempDir("export-reorder-"), "export");
    exportProject(withSectionOrder(moved), { outDir, skipBuild: true });

    const index = readOut(outDir, "src/pages/home/index.tsx");
    expect(renderedOrder(index)).toEqual(moved);
    // every section still renders exactly once, with its data spread intact
    for (const id of HOME_ORDER) expect(index).toContain(`nodeId="${id}"`);
    expect(index).toContain("{...heroData}");
  });

  it("is a no-op when the order matches the source", () => {
    const outDir = join(tempDir("export-reorder-noop-"), "export");
    exportProject(withSectionOrder(HOME_ORDER), { outDir, skipBuild: true });
    expect(renderedOrder(readOut(outDir, "src/pages/home/index.tsx"))).toEqual(HOME_ORDER);
  });

  it("refuses an order that omits a section rather than dropping it", () => {
    // Silent content loss is the failure mode this project exists to prevent.
    const outDir = join(tempDir("export-reorder-partial-"), "export");
    expect(() => exportProject(withSectionOrder(HOME_ORDER.slice(0, 3)), { outDir, skipBuild: true })).toThrow(
      /omits .*a reorder must list every section/s,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses an unknown section id", () => {
    const outDir = join(tempDir("export-reorder-unknown-"), "export");
    expect(() =>
      exportProject(withSectionOrder([...HOME_ORDER, "home.does-not-exist"]), { outDir, skipBuild: true }),
    ).toThrow(/not an active section/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses a duplicated section id", () => {
    const outDir = join(tempDir("export-reorder-dupe-"), "export");
    expect(() =>
      exportProject(withSectionOrder([HOME_ORDER[0]!, ...HOME_ORDER]), { outDir, skipBuild: true }),
    ).toThrow(/more than once/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("reorders inside a page-archetype layout wrapper without stripping it", () => {
    // A marketing page returns a bare fragment; an app screen wraps its
    // sections in a flex row so its panes sit side by side instead of stacking.
    // Reorder has to find the sections' real parent either way, and rebuild it
    // with its OWN tags — emitting a bare fragment would reorder correctly and
    // silently delete the layout that positions them.
    const dir = fixtureCopyWithOverrides([]);
    const indexPath = join(dir, "src", "pages", "about", "index.tsx");
    const wrapped = readFileSync(indexPath, "utf8")
      .replace("    <>", '    <div className="flex min-h-screen flex-wrap">')
      .replace("    </>", "    </div>");
    writeFileSync(indexPath, wrapped);
    writeFileSync(
      join(dir, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          { nodeId: "about", channel: "sectionOrder", value: ["about.values", "about.intro"] },
        ],
      }),
    );
    const outDir = join(tempDir("export-reorder-layout-"), "export");
    exportProject(dir, { outDir, skipBuild: true });

    const index = readOut(outDir, "src/pages/about/index.tsx");
    expect(index, "the layout wrapper must survive the rewrite").toContain(
      'className="flex min-h-screen flex-wrap"',
    );
    expect(index).not.toContain("<>");
    const values = index.indexOf('nodeId="about.values"');
    const placeholder = index.indexOf("<FailedSectionPlaceholder />");
    const intro = index.indexOf('nodeId="about.intro"');
    expect(values).toBeGreaterThan(-1);
    expect(placeholder).toBeGreaterThan(values);
    expect(intro).toBeGreaterThan(placeholder);
  });

  it("keeps a failed-section placeholder in place — it carries no id to reorder by", () => {
    // about/index.tsx renders AboutIntro, then <FailedSectionPlaceholder />,
    // then AboutValues. The placeholder deliberately has no nodeId (pipeline
    // 5.4), so a reorder must neither drop it nor try to position it: swapping
    // the two real sections has to move them AROUND it, leaving it in the
    // middle slot it already occupied.
    const dir = fixtureCopyWithOverrides([]);
    writeFileSync(
      join(dir, "overrides", "about.overrides.json"),
      JSON.stringify({
        version: 1,
        route: "/about",
        overrides: [
          { nodeId: "about", channel: "sectionOrder", value: ["about.values", "about.intro"] },
        ],
      }),
    );
    const outDir = join(tempDir("export-reorder-placeholder-"), "export");
    exportProject(dir, { outDir, skipBuild: true });

    const index = readOut(outDir, "src/pages/about/index.tsx");
    expect(index).toContain("<FailedSectionPlaceholder />");
    const values = index.indexOf('nodeId="about.values"');
    const placeholder = index.indexOf("<FailedSectionPlaceholder />");
    const intro = index.indexOf('nodeId="about.intro"');
    expect(values, "about.values is missing from the reordered page").toBeGreaterThan(-1);
    expect(placeholder, "the placeholder moved up with the section that swapped past it").toBeGreaterThan(values);
    expect(intro, "the placeholder did not stay in its own slot").toBeGreaterThan(placeholder);
  });
});

/**
 * The borrowed node_modules link (task 3b). The verification build runs the
 * EXPORT's own `npm run build`, which needs dependencies the export does not
 * ship, so it borrows the source project's tree through a directory link and
 * removes the link again afterwards.
 *
 * Both tests assert BEHAVIOUR — reads resolve through the link; removal leaves
 * the source tree whole — and neither one may look at `process.platform`. That
 * is the point: a Windows junction and a POSIX symlink are the same object to
 * everything above them, and the bug being fixed was `rmdirSync` on a symlink
 * (ENOTDIR), thrown from a `finally`, which turned a SUCCESSFUL export into a
 * failure and replaced any genuine ExportError with it.
 */
describe("the borrowed node_modules directory link", () => {
  function sourceTreeWithMarker(): { source: string; link: string } {
    const dir = tempDir("export-link-");
    const source = join(dir, "source-node-modules");
    mkdirSync(join(source, "some-package"), { recursive: true });
    writeFileSync(join(source, "some-package", "index.js"), "module.exports = 1;\n");
    return { source, link: join(dir, "node_modules") };
  }

  it("creates a link that resolves to the source directory", () => {
    const { source, link } = sourceTreeWithMarker();
    linkDirectory(source, link);
    try {
      expect(readFileSync(join(link, "some-package", "index.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(realpathSync(link)).toBe(realpathSync(source));
    } finally {
      // Removed inside the test, not left to afterAll: a stray link is the
      // shape of defect that recursively deleted 195 tracked files in task 3.
      removeDirectoryLink(link);
    }
  });

  it("removes the link and leaves every file in the source tree", () => {
    const { source, link } = sourceTreeWithMarker();
    linkDirectory(source, link);

    removeDirectoryLink(link);

    expect(existsSync(link)).toBe(false);
    expect(existsSync(source), "removal followed the link into the source tree").toBe(true);
    expect(readFileSync(join(source, "some-package", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  /**
   * A DANGLING source link is the state every generated project is in after the
   * repository root is renamed, and that a container-built project is in on a
   * host. `existsSync` follows the link, so it answered `false` — identical to
   * owning no dependencies — and the old guard therefore skipped linking and
   * ran `npm run build` anyway. Node then walked UP out of the export and
   * resolved against whatever `node_modules` sat above it (here, the one in the
   * user's home directory), so a stale link surfaced as four TypeScript errors
   * blaming `@types/react-dom` in a project that already declares it.
   *
   * Asserted on the MESSAGE, because the whole defect was a true failure
   * reported as the wrong cause.
   */
  it(
    "refuses when the source link dangles, rather than building against whatever sits up the tree",
    { timeout: 180_000 },
    () => {
      const project = fixtureCopyWithOverrides([]);
      const borrowed = join(tempDir("borrowed-modules-"), "node_modules");
      mkdirSync(join(borrowed, "some-package"), { recursive: true });
      linkDirectory(borrowed, join(project, "node_modules"));
      rmSync(borrowed, { recursive: true, force: true });

      expect(() => exportProject(project, { outDir: join(tempDir("export-dangling-"), "out") })).toThrow(
        /directory link whose target no longer exists/,
      );
    },
  );
});
