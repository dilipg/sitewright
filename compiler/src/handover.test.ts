import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectHandoverData, generateHandover, renderHandover } from "./handover";
import type { Manifest } from "./manifest";

const fixtureDir = fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));
const fixtureManifest = JSON.parse(
  readFileSync(`${fixtureDir}/manifest.json`, "utf8"),
) as Manifest;

describe("collectHandoverData: props/mock seam map", () => {
  it("maps every section to its component file and mock data file", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const hero = data.sections.find((s) => s.component === "Hero")!;
    expect(hero.routeSlug).toBe("home");
    expect(hero.routePath).toBe("/");
    expect(hero.sectionFile).toBe("src/pages/home/sections/Hero.tsx");
    expect(hero.mockFile).toBe("src/pages/home/mock/Hero.data.ts");
  });

  it("lists content props but not handler props", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const contactForm = data.sections.find((s) => s.component === "ContactForm")!;
    expect(contactForm.contentProps).toContain("heading");
    expect(contactForm.contentProps).toContain("submitLabel");
    expect(contactForm.contentProps).not.toContain("onSubmit");
  });

  it("covers every route directory, sorted deterministically", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const slugs = [...new Set(data.sections.map((s) => s.routeSlug))];
    expect(slugs).toEqual(["about", "home", "support"]);
  });
});

describe("collectHandoverData: integration TODOs", () => {
  it("finds a handler prop wired to a no-op, with its real type signature", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const submit = data.integrations.find((seam) => seam.propName === "onSubmit")!;
    expect(submit.component).toBe("ContactForm");
    expect(submit.routeSlug).toBe("support");
    expect(submit.signature).toBe("(values: ContactFormValues) => void");
    expect(submit.mockFile).toBe("src/pages/support/mock/ContactForm.data.ts");
    expect(submit.line).toBeGreaterThan(0);
  });

  it("captures the TODO note so the reader knows what to wire", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const submit = data.integrations.find((seam) => seam.propName === "onSubmit")!;
    expect(submit.note).toContain("integrate");
  });

  it("reports a handler that lost its TODO marker instead of silently skipping it", () => {
    // AST shape, not the comment, is what makes a stub a stub — a dropped
    // marker is exactly the gap a handover reader would otherwise hit blind.
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    const withoutNote = data.integrations.filter((seam) => seam.note === undefined);
    for (const seam of withoutNote) {
      expect(seam.propName).toMatch(/^on[A-Z]/);
    }
    // the fixture's only handler DOES carry its marker
    expect(withoutNote).toHaveLength(0);
  });

  it("finds no false positives among non-interactive sections", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, []);
    expect(data.integrations.map((s) => `${s.component}.${s.propName}`)).toEqual([
      "ContactForm.onSubmit",
    ]);
  });
});

describe("collectHandoverData: off-scale overrides", () => {
  const overrides = [
    { nodeId: "home.hero", channel: "style", value: { background: "color.semantic.accent" } },
    { nodeId: "home.hero.headline", channel: "style", value: { color: "#ff5500" } },
    { nodeId: "home.hero.subheadline", channel: "layout", value: { marginTop: "13px" } },
    { nodeId: "home.hero.cta-primary", channel: "text", value: "Start now" },
  ];

  it("lists free values and omits token references", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, overrides);
    expect(data.offScale).toEqual([
      { nodeId: "home.hero.headline", channel: "style", property: "color", value: "#ff5500" },
      { nodeId: "home.hero.subheadline", channel: "layout", property: "marginTop", value: "13px" },
    ]);
  });

  it("ignores text-channel overrides entirely", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, overrides);
    expect(data.offScale.some((entry) => entry.value === "Start now")).toBe(false);
  });

  it("counts every applied override, off-scale or not", () => {
    const data = collectHandoverData(fixtureDir, fixtureManifest, overrides);
    expect(data.appliedOverrides).toBe(4);
  });
});

describe("renderHandover", () => {
  it("renders every section", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toContain("# Handover");
    expect(markdown).toContain("## 1. Where the content lives");
    expect(markdown).toContain("## 2. Integration TODOs");
    expect(markdown).toContain("## 3. Off-scale overrides");
    expect(markdown).toContain("## 4. Node ids, and why your data keys matter");
    expect(markdown).toContain("## 5. What is yours to edit");
    expect(markdown).toContain("## 6. Running it");
  });

  // Each of these answers a specific friction point a real developer hit
  // working only from this document (docs/reports/m6-handover-trial.md).
  it("documents the async/stateful seam instead of promising a data-file swap", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    // the old text claimed an API swap meant "replacing the data file's export",
    // which is impossible: the file exports a module-level const
    expect(markdown).toContain("page container");
    expect(markdown).toContain("src/pages/<route>/index.tsx");
    expect(markdown).toMatch(/cannot hold a promise/);
  });

  it("warns that sections do no arithmetic and have no loading state", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toMatch(/no arithmetic/);
    expect(markdown).toMatch(/no loading or error state/);
  });

  it("warns that a list item's data key becomes part of its node id", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toMatch(/item-\$\{item\.key\}/);
    expect(markdown).toMatch(/database integers or array indices/);
  });

  it("says which paths survive a regeneration, including itself", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toContain("What is yours to edit");
    expect(markdown).toMatch(/HANDOVER\.md` \| regenerated on every export/);
    expect(markdown).toContain("src/lib/");
  });

  it("explains the two files nothing else documents", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toContain("design-inventory.json");
    expect(markdown).toContain("manifest.json");
  });

  it("warns about the dev-server watch trap a local back-end hits", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toMatch(/watch: \{ ignored/);
    expect(markdown).toMatch(/destroys React state/);
  });

  it("names every integration seam with its file and line", () => {
    const markdown = generateHandover(fixtureDir, fixtureManifest, []);
    expect(markdown).toContain("`onSubmit`");
    expect(markdown).toContain("src/pages/support/mock/ContactForm.data.ts");
  });

  it("says so explicitly when there is nothing to integrate or normalize", () => {
    const empty = {
      sections: [],
      integrations: [],
      offScale: [],
      routeCount: 0,
      nodeCount: 0,
      appliedOverrides: 0,
    };
    const markdown = renderHandover(empty);
    expect(markdown).toContain("no interactive elements to wire up");
    expect(markdown).toContain("every canvas edit resolved to a design token");
  });

  it("is deterministic: same input renders byte-identically", () => {
    const first = generateHandover(fixtureDir, fixtureManifest, []);
    const second = generateHandover(fixtureDir, fixtureManifest, []);
    expect(first).toBe(second);
  });

  it("escapes pipes so a value containing one cannot break the table", () => {
    const markdown = renderHandover({
      sections: [],
      integrations: [],
      offScale: [
        { nodeId: "home.hero", channel: "style", property: "fontFamily", value: "a|b" },
      ],
      routeCount: 1,
      nodeCount: 1,
      appliedOverrides: 1,
    });
    expect(markdown).toContain("a\\|b");
  });
});
