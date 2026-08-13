import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GateReport } from "./gates";
import { runGates } from "./gates";

const fixturesDir = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const cleanFixture = `${fixturesDir}acme-landing`;
const broken = (name: string) => `${fixturesDir}broken/${name}`;

function failedGates(report: GateReport): number[] {
  return report.gates.filter((g) => !g.passed).map((g) => g.gate);
}

function failuresOf(report: GateReport, gate: number) {
  return report.gates.find((g) => g.gate === gate)?.failures ?? [];
}

describe("runGates: clean fixture", () => {
  it("passes all six gates on fixtures/acme-landing", () => {
    const report = runGates(cleanFixture);
    expect(failedGates(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.gates).toHaveLength(6);
  });
});

describe("runGates: each broken variant fails exactly its gate", () => {
  it("gate 1: unresolvable import", () => {
    const report = runGates(broken("gate1-unresolved-import"));
    expect(failedGates(report)).toEqual([1]);

    // Found by the whole-branch review: this used to read `failuresOf(...)[0]`
    // and assert `Hero.tsx` on it, which made the test RED ON LINUX while CI
    // runs `ubuntu-latest`. Gate 1 runs the project's own `tsc --noEmit`, and
    // tsc's diagnostic ORDER is not a guarantee — on Linux `src/main.tsx` comes
    // first. The property under test is "gate 1 catches the unresolved import in
    // Hero.tsx", never "it is reported first", so the assertion should not have
    // depended on position. Selecting the failure by file makes it true on both
    // platforms without branching on one.
    const failures = failuresOf(report, 1);
    const failure = failures.find((f) => f.file?.includes("Hero.tsx") === true);
    expect(
      failure,
      `no gate-1 failure named Hero.tsx; got ${failures.map((f) => f.file ?? "(no file)").join(", ")}`,
    ).toBeDefined();
    expect(failure!.reason).toBe("unresolved-import");
    expect(failure!.message).toContain("./format");
  });

  it("gate 2: dangling href", () => {
    const report = runGates(broken("gate2-dangling-href"));
    expect(failedGates(report)).toEqual([2]);
    const failure = failuresOf(report, 2)[0]!;
    expect(failure.reason).toBe("dangling-href");
    expect(failure.message).toContain("/pricing");
    expect(failure.message).toContain("routes.ts");
  });

  it("gate 3: raw hex and raw px in a section", () => {
    const report = runGates(broken("gate3-raw-hex"));
    expect(failedGates(report)).toEqual([3]);
    const reasons = failuresOf(report, 3).map((f) => f.reason);
    expect(reasons).toContain("raw-hex");
    expect(reasons).toContain("raw-px");
    expect(failuresOf(report, 3)[0]?.message).toContain("token");
  });

  it("gate 4: manifest node never attached to an element", () => {
    const report = runGates(broken("gate4-missing-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("missing-node-id");
    expect(failure.message).toContain("home.hero.headline");
  });

  it("gate 4: duplicate data-node-id", () => {
    const report = runGates(broken("gate4-duplicate-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("duplicate-node-id");
    expect(failure.message).toContain("home.hero.headline");
  });

  it("gate 4: element carries an ID missing from the manifest", () => {
    const report = runGates(broken("gate4-unregistered-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("unregistered-node-id");
    expect(failure.message).toContain("home.hero.badge");
  });

  it("gate 5: hardcoded user-visible string in section JSX", () => {
    const report = runGates(broken("gate5-hardcoded-string"));
    expect(failedGates(report)).toEqual([5]);
    const failure = failuresOf(report, 5)[0]!;
    expect(failure.reason).toBe("hardcoded-string");
    expect(failure.message).toContain("Welcome to Acme");
    expect(failure.message).toContain("props");
  });

  it("gate 6: cross-page import", () => {
    const report = runGates(broken("gate6-cross-page-import"));
    expect(failedGates(report)).toEqual([6]);
    const failure = failuresOf(report, 6)[0]!;
    expect(failure.reason).toBe("cross-page-import");
    expect(failure.message).toContain("pricing");
    expect(failure.file).toContain("index.tsx");
  });
});

describe("runGates: ownership boundary via written-files log", () => {
  it("flags files written outside the owner's boundary", () => {
    const report = runGates(cleanFixture, {
      ownershipMap: { "page:home": ["src/pages/home/"] },
      writtenFiles: { "page:home": ["src/pages/home/index.tsx", "src/shell/Nav.tsx"] },
    });
    expect(failedGates(report)).toEqual([6]);
    const failure = failuresOf(report, 6)[0]!;
    expect(failure.reason).toBe("out-of-boundary-write");
    expect(failure.message).toContain("src/shell/Nav.tsx");
    expect(failure.message).toContain("page:home");
  });

  it("passes when written files stay inside the boundary", () => {
    const report = runGates(cleanFixture, {
      ownershipMap: { "page:home": ["src/pages/home/"] },
      writtenFiles: { "page:home": ["src/pages/home/index.tsx"] },
    });
    expect(report.passed).toBe(true);
  });
});

describe("runGates: gate 4 scopeRoute (concurrent page fan-out)", () => {
  const brokenOtherRoute = broken("gate4-missing-node-id"); // fixture's "home" route has an unattached manifest node

  it("unscoped: a stray other-route problem is visible (baseline)", () => {
    const report = runGates(brokenOtherRoute);
    expect(failedGates(report)).toEqual([4]);
  });

  it("scoped to a DIFFERENT route: sibling's in-flight/broken state is invisible", () => {
    // simulates a page worker validating "pricing" while sibling route
    // "home" is mid-generation (its manifest node not yet attached) —
    // must not fail pricing's own gate check for home's problem
    const report = runGates(brokenOtherRoute, { scopeRoute: "pricing" });
    expect(report.gates.find((g) => g.gate === 4)?.passed).toBe(true);
  });

  it("scoped to the SAME route: the route's own problem still fails", () => {
    const report = runGates(brokenOtherRoute, { scopeRoute: "home" });
    expect(failedGates(report)).toEqual([4]);
  });

  it("skipMissingCheck: a section root only attached via {nodeId} in the not-yet-written page index.tsx does not spuriously fail", () => {
    // fan-out writes a section's own files before the page is assembled
    // (build prompt 5.3): the section ROOT's literal attachment normally
    // lives in index.tsx's <Hero nodeId="home.hero" />, which doesn't
    // exist yet during a section's own mid-retry gate check — the root
    // is only ever attached via a {nodeId} JSX EXPRESSION inside the
    // section file itself, which gate 4 correctly never treats as a
    // literal attachment (contract: root id comes from the nodeId prop).
    const dir = mkdtempSync(join(tmpdir(), "gate4-preassembly-"));
    mkdirSync(join(dir, "src", "pages", "home", "sections"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "home.hero": {
            route: "/",
            file: "src/pages/home/sections/Hero.tsx",
            component: "Hero",
            element: "section",
            editable: ["style"],
            status: "active",
          },
          "home.hero.headline": {
            route: "/",
            file: "src/pages/home/sections/Hero.tsx",
            component: "Hero",
            element: "Heading",
            editable: ["text"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "home", "sections", "Hero.tsx"),
      'export default function Hero({ nodeId, headline }: { nodeId?: string; headline: string }) {\n' +
        '  return (\n' +
        '    <section data-node-id={nodeId}>\n' +
        '      <h1 nodeId="home.hero.headline">{headline}</h1>\n' +
        '    </section>\n' +
        '  );\n' +
        '}\n',
    );

    const unscoped = runGates(dir, {});
    expect(unscoped.gates.find((g) => g.gate === 4)?.passed).toBe(false); // baseline: root looks "missing" without the flag

    const report = runGates(dir, { scopeRoute: "home", skipMissingCheck: true });
    expect(report.gates.find((g) => g.gate === 4)?.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skipMissingCheck still catches a genuinely unregistered attached id", () => {
    const report = runGates(broken("gate4-unregistered-node-id"), {
      scopeRoute: "home",
      skipMissingCheck: true,
    });
    expect(failedGates(report)).toEqual([4]);
    expect(report.gates.find((g) => g.gate === 4)?.failures[0]?.reason).toBe(
      "unregistered-node-id",
    );
  });

  it("skipMissingCheck exempts only section-root ids (route.section, 2 segments), not children", () => {
    // A route with two sections: "hero" already committed (its root is
    // legitimately unattached pre-assembly) and "grid" currently being
    // checked, which has a genuinely unattached CHILD id (3+ segments) —
    // that child must still fail even though skipMissingCheck is set,
    // proving the flag no longer blanket-skips the whole route.
    const dir = mkdtempSync(join(tmpdir(), "gate4-root-only-exempt-"));
    mkdirSync(join(dir, "src", "pages", "shop", "sections"), { recursive: true });
    mkdirSync(join(dir, "src", "shell"), { recursive: true });
    writeFileSync(join(dir, "src", "shell", "routes.ts"), "export const routes = [];\n");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "shop.hero": {
            route: "/shop",
            file: "src/pages/shop/sections/Hero.tsx",
            component: "Hero",
            element: "section",
            editable: ["style"],
            status: "active",
          },
          "shop.grid": {
            route: "/shop",
            file: "src/pages/shop/sections/Grid.tsx",
            component: "Grid",
            element: "section",
            editable: ["style"],
            status: "active",
          },
          "shop.grid.heading": {
            route: "/shop",
            file: "src/pages/shop/sections/Grid.tsx",
            component: "Grid",
            element: "Heading",
            editable: ["text"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "shop", "sections", "Hero.tsx"),
      'export default function Hero({ nodeId }: { nodeId?: string }) {\n' +
        '  return <section data-node-id={nodeId} />;\n' +
        '}\n',
    );
    writeFileSync(
      join(dir, "src", "pages", "shop", "sections", "Grid.tsx"),
      // "heading" is never attached anywhere — a genuine defect that must
      // still be caught during this section's own pre-assembly check.
      'export default function Grid({ nodeId }: { nodeId?: string }) {\n' +
        '  return <section data-node-id={nodeId} />;\n' +
        '}\n',
    );

    const report = runGates(dir, { scopeRoute: "shop", skipMissingCheck: true });
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("missing-node-id");
    expect(failure.message).toContain("shop.grid.heading");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGates: gate 4 recognizes map-derived list-item node ids (contract 5.2)", () => {
  it("a nodeId built from a template literal inside a .map() callback is not flagged as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate4-map-derived-"));
    mkdirSync(join(dir, "src", "pages", "shop", "sections"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "shop.products": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "section",
            editable: ["style"],
            status: "active",
          },
          "shop.products.card-meadow-wrap-dress": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "Card",
            editable: ["style"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "shop", "sections", "ProductGrid.tsx"),
      // Root uses a literal id here (isolating this test to the list-item
      // recognition alone; root pre-assembly exemption is covered separately).
      'export default function ProductGrid({ products }: { products: { key: string }[] }) {\n' +
        '  return (\n' +
        '    <section data-node-id="shop.products">\n' +
        '      {products.map((product) => (\n' +
        '        <div key={product.key} nodeId={`shop.products.card-${product.key}`} />\n' +
        '      ))}\n' +
        '    </section>\n' +
        '  );\n' +
        '}\n',
    );

    const report = runGates(dir, { scopeRoute: "shop" });
    expect(report.gates.find((g) => g.gate === 4)?.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a nodeId built via a local const (template literal, then referenced by name) inside a .map() is not flagged as missing", () => {
    // Live-observed real generation: instead of repeating the template
    // literal on every sub-element, the model factors it into a local
    // `const itemId = ...` inside the map callback and references it by
    // name — semantically identical to the direct-template-literal case,
    // just idiomatic JS. Gate 4 must trace the identifier back to its
    // declaration, not just recognize a literal template expression.
    const dir = mkdtempSync(join(tmpdir(), "gate4-map-derived-local-const-"));
    mkdirSync(join(dir, "src", "pages", "shop", "sections"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "shop.products.card-meadow-wrap-dress": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "Card",
            editable: ["style"],
            status: "active",
          },
          "shop.products.card-meadow-wrap-dress.image": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "Image",
            editable: ["style"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "shop", "sections", "ProductGrid.tsx"),
      'export default function ProductGrid({ nodeId, products }: { nodeId?: string; products: { key: string }[] }) {\n' +
        '  return (\n' +
        '    <section data-node-id={nodeId}>\n' +
        '      {products.map((product) => {\n' +
        '        const itemId = `${nodeId}.card-${product.key}`;\n' +
        '        return (\n' +
        '          <div key={product.key} nodeId={itemId}>\n' +
        '            <img nodeId={`${itemId}.image`} />\n' +
        '          </div>\n' +
        '        );\n' +
        '      })}\n' +
        '    </section>\n' +
        '  );\n' +
        '}\n',
    );

    const report = runGates(dir, { scopeRoute: "shop", skipMissingCheck: true });
    expect(report.gates.find((g) => g.gate === 4)?.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a computed nodeId OUTSIDE a .map() callback is not exempt — still flagged as missing", () => {
    // Contract 5.2: only list items (inside a map) derive computed ids;
    // static children must carry literal ids. A non-list child that uses
    // a template expression is a real defect, not a list pattern.
    const dir = mkdtempSync(join(tmpdir(), "gate4-non-map-computed-"));
    mkdirSync(join(dir, "src", "pages", "shop", "sections"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "shop.products": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "section",
            editable: ["style"],
            status: "active",
          },
          "shop.products.eyebrow": {
            route: "/shop",
            file: "src/pages/shop/sections/ProductGrid.tsx",
            component: "ProductGrid",
            element: "Text",
            editable: ["text"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "shop", "sections", "ProductGrid.tsx"),
      'export default function ProductGrid({ nodeId, eyebrow }: { nodeId?: string; eyebrow: string }) {\n' +
        '  return (\n' +
        '    <section data-node-id={nodeId}>\n' +
        '      <p nodeId={`${nodeId}.eyebrow`}>{eyebrow}</p>\n' +
        '    </section>\n' +
        '  );\n' +
        '}\n',
    );

    // skipMissingCheck exempts the section root ("shop.products") but must
    // still catch the non-list child.
    const report = runGates(dir, { scopeRoute: "shop", skipMissingCheck: true });
    expect(report.gates.find((g) => g.gate === 4)?.passed).toBe(false);
    const failures = failuresOf(report, 4);
    expect(failures.map((f) => f.reason)).toEqual(["missing-node-id"]);
    expect(failures[0]?.message).toContain("shop.products.eyebrow");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a list-item pattern's wildcard does not accidentally swallow an unrelated sibling id", () => {
    // Live-observed real bug: section slug "feature-grid" contains the
    // literal substring ".feature-" once dotted onto its route (routeSlug
    // + "." + "feature-grid..."), which is ALSO the static text in the
    // list-item pattern `${nodeId}.feature-${feature.key}`. The OLD
    // unrestricted `.+...+` wildcard pattern matched that coincidence and
    // wrongly exempted a completely unrelated, non-list, still-missing
    // "eyebrow" child from the same file. Only a genuine list-item id
    // (ending in a dot-free slug right after ".feature-") may be exempted.
    const dir = mkdtempSync(join(tmpdir(), "gate4-wildcard-collision-"));
    mkdirSync(join(dir, "src", "pages", "home", "sections"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: 1,
        nodes: {
          "home.feature-grid.eyebrow": {
            route: "/",
            file: "src/pages/home/sections/FeatureGrid.tsx",
            component: "FeatureGrid",
            element: "Text",
            editable: ["text"],
            status: "active",
          },
          "home.feature-grid.feature-sync": {
            route: "/",
            file: "src/pages/home/sections/FeatureGrid.tsx",
            component: "FeatureGrid",
            element: "Card",
            editable: ["style"],
            status: "active",
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "src", "pages", "home", "sections", "FeatureGrid.tsx"),
      'export default function FeatureGrid({ nodeId, eyebrow, features }: { nodeId?: string; eyebrow: string; features: { key: string }[] }) {\n' +
        '  return (\n' +
        '    <section data-node-id={nodeId}>\n' +
        // "eyebrow" is a real defect (non-list child, never actually attached
        // by a literal) that must still be caught, even though this same
        // file legitimately uses the ".feature-<key>" list pattern below.
        '      <p nodeId={`${nodeId}.eyebrow`}>{eyebrow}</p>\n' +
        '      {features.map((feature) => (\n' +
        '        <div key={feature.key} nodeId={`${nodeId}.feature-${feature.key}`} />\n' +
        '      ))}\n' +
        '    </section>\n' +
        '  );\n' +
        '}\n',
    );

    const report = runGates(dir, { scopeRoute: "home" });
    const failures = failuresOf(report, 4);
    expect(failures.map((f) => f.reason)).toEqual(["missing-node-id"]);
    expect(failures[0]?.message).toContain("home.feature-grid.eyebrow");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGates: gate 7 (regen ID survival)", () => {
  it("passes when every previously-overridden ID is still attached", () => {
    const report = runGates(cleanFixture, {
      regen: { overriddenNodeIds: ["home.hero.headline", "home.hero.cta-primary"], declaredOrphans: [] },
    });
    expect(report.passed).toBe(true);
    expect(report.gates.map((g) => g.gate)).toContain(7);
  });

  it("fails when an overridden ID is missing and undeclared", () => {
    const report = runGates(cleanFixture, {
      regen: { overriddenNodeIds: ["home.hero.vanished"], declaredOrphans: [] },
    });
    expect(failedGates(report)).toEqual([7]);
    const failure = failuresOf(report, 7)[0]!;
    expect(failure.reason).toBe("undeclared-orphan");
    expect(failure.message).toContain("home.hero.vanished");
    expect(failure.message).toContain("orphanedOverrides");
  });

  it("passes when a removed overridden ID is declared in orphanedOverrides", () => {
    const report = runGates(cleanFixture, {
      regen: {
        overriddenNodeIds: ["home.hero.headline", "home.hero.vanished"],
        declaredOrphans: ["home.hero.vanished"],
      },
    });
    expect(report.passed).toBe(true);
  });

  it("fails when a declared orphan is actually still attached (false orphan)", () => {
    const report = runGates(cleanFixture, {
      regen: {
        overriddenNodeIds: ["home.hero.headline"],
        declaredOrphans: ["home.hero.headline"],
      },
    });
    expect(failedGates(report)).toEqual([7]);
    expect(failuresOf(report, 7)[0]?.reason).toBe("false-orphan");
  });

  it("gate 7 is absent from non-regen runs", () => {
    const report = runGates(cleanFixture);
    expect(report.gates.map((g) => g.gate)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("gates CLI argument handling", () => {
  it("parses a plain non-regen invocation (regression: --regen index math ate the projectDir)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath: toPath } = await import("node:url");
    const cliPath = toPath(new URL("../scripts/gates.ts", import.meta.url));
    const stdout = execFileSync("node", [cliPath, cleanFixture, "--json"], { encoding: "utf8" });
    const report = JSON.parse(stdout) as GateReport;
    expect(report.passed).toBe(true);
    expect(report.gates).toHaveLength(6);
  });
});

describe("runGates: report structure", () => {
  it("reports all six gates with ids and names regardless of outcome", () => {
    const report = runGates(broken("gate3-raw-hex"));
    expect(report.gates.map((g) => g.gate)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const gate of report.gates) {
      expect(gate.name).toBeTruthy();
      expect(typeof gate.passed).toBe("boolean");
    }
  });
});

describe("runGates: gate 2 parameterized routes (storefront product pages)", () => {
  // The Shell Agent legitimately emits parameterized route paths for
  // storefront sites — one product-detail page at "/products/:handle"
  // serving every product URL. Gate 2 must treat an href as valid when it
  // matches a parameterized route segment-wise (":param" matches exactly
  // one non-empty segment), not only when it equals a path literally.
  // See docs/decisions.md (2026-07-30) — first surfaced by the milestone
  // 6.1 storefront acceptance run, where every product-card link burned
  // its section's whole retry budget against an exact-match-only gate 2.
  function paramProject(hrefs: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "gate2-param-routes-"));
    mkdirSync(join(dir, "src", "shell"), { recursive: true });
    mkdirSync(join(dir, "src", "pages", "home", "mock"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, nodes: {} }));
    writeFileSync(
      join(dir, "src", "shell", "routes.ts"),
      "export const routes = [\n" +
        '  { slug: "home", path: "/", title: "Home" },\n' +
        '  { slug: "shop", path: "/shop", title: "Shop" },\n' +
        '  { slug: "product", path: "/products/:handle", title: "Product" },\n' +
        "];\n",
    );
    writeFileSync(
      join(dir, "src", "pages", "home", "mock", "Links.data.ts"),
      "export const linksData = {\n" +
        hrefs.map((href, i) => `  link${i}: { label: "L${i}", href: ${JSON.stringify(href)} },\n`).join("") +
        "};\n",
    );
    return dir;
  }

  it("an href filling a :param segment matches the parameterized route", () => {
    const dir = paramProject(["/products/driftwood-dusk", "/shop", "/"]);
    const report = runGates(dir);
    expect(failuresOf(report, 2)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an href with extra trailing segments does not match", () => {
    const dir = paramProject(["/products/driftwood-dusk/reviews"]);
    const report = runGates(dir);
    expect(failuresOf(report, 2).map((f) => f.reason)).toEqual(["dangling-href"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an href missing the :param segment does not match", () => {
    const dir = paramProject(["/products"]);
    const report = runGates(dir);
    expect(failuresOf(report, 2).map((f) => f.reason)).toEqual(["dangling-href"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an href whose static segment differs does not match", () => {
    const dir = paramProject(["/prods/driftwood-dusk"]);
    const report = runGates(dir);
    expect(failuresOf(report, 2).map((f) => f.reason)).toEqual(["dangling-href"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGates: gate 1 typecheck (contract section 8's \"build passes\")", () => {
  // The static import scan satisfies only the first half of gate 1. Without
  // the typecheck a section can use a field it never declared, pass every
  // gate, and abort the export after the whole run's spend — observed live
  // (docs/decisions.md 2026-07-30).
  it("passes on the clean fixture", { timeout: 180_000 }, () => {
    const report = runGates(cleanFixture, { typecheck: true });
    expect(failuresOf(report, 1)).toEqual([]);
  });

  it("reports a real type error as a gate 1 failure with file and line", { timeout: 180_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "gate1-typecheck-"));
    // Borrow the fixture wholesale (it has node_modules + tsconfig), then
    // introduce the exact defect seen live: a field used but never declared.
    cpSync(cleanFixture, dir, { recursive: true, filter: (src) => !src.includes("dist") });
    const heroPath = join(dir, "src", "pages", "home", "sections", "Hero.tsx");
    writeFileSync(
      heroPath,
      readFileSync(heroPath, "utf8").replace("{headline}", "{headline}{undeclaredField}"),
    );

    const report = runGates(dir, { typecheck: true });
    const failures = failuresOf(report, 1);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.reason).toBe("typecheck-error");
    expect(failures[0]!.file).toContain("Hero.tsx");
    expect(failures[0]!.line).toBeGreaterThan(0);
    expect(failures[0]!.message).toMatch(/TS\d+/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is off unless asked for, so the static gates stay fast", () => {
    const report = runGates(cleanFixture);
    expect(failuresOf(report, 1)).toEqual([]);
    // no typescript needed: a bare synthetic project still passes gate 1
    const dir = mkdtempSync(join(tmpdir(), "gate1-no-tsc-"));
    mkdirSync(join(dir, "src", "shell"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, nodes: {} }));
    writeFileSync(join(dir, "src", "shell", "routes.ts"), "export const routes = [];\n");
    expect(failuresOf(runGates(dir), 1)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says so loudly when a typecheck is requested but typescript is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate1-missing-tsc-"));
    mkdirSync(join(dir, "src", "shell"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, nodes: {} }));
    writeFileSync(join(dir, "src", "shell", "routes.ts"), "export const routes = [];\n");
    const failures = failuresOf(runGates(dir, { typecheck: true }), 1);
    expect(failures[0]!.reason).toBe("typecheck-unavailable");
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "scopeRoute confines diagnostics to that route, so a sibling's half-written page cannot fail it",
    { timeout: 180_000 },
    () => {
      // This is what makes the typecheck safe under parallel fan-out:
      // typechecking is whole-program, but a worker must only answer for its
      // own route (the same containment gate 4 already applies).
      const dir = mkdtempSync(join(tmpdir(), "gate1-scoped-typecheck-"));
      cpSync(cleanFixture, dir, { recursive: true, filter: (src) => !src.includes("dist") });
      const aboutPath = join(dir, "src", "pages", "about", "sections", "AboutIntro.tsx");
      writeFileSync(
        aboutPath,
        readFileSync(aboutPath, "utf8").replace("export default function", "const broken: number = \"nope\";\nexport default function"),
      );

      // whole-project run sees it...
      expect(failuresOf(runGates(dir, { typecheck: true }), 1).length).toBeGreaterThan(0);
      // ...but the home worker is not blamed for the about route
      expect(failuresOf(runGates(dir, { typecheck: true, scopeRoute: "home" }), 1)).toEqual([]);
      // ...and the about worker still is
      expect(
        failuresOf(runGates(dir, { typecheck: true, scopeRoute: "about" }), 1).length,
      ).toBeGreaterThan(0);
      rmSync(dir, { recursive: true, force: true });
    },
  );
});

describe("runGates: scopeRoute contains gates 1/2/3/5/6 (milestone 7.2)", () => {
  // Until 7.2 only gate 4 (and 6.4's typecheck) honoured scopeRoute, so during
  // parallel fan-out a page worker could fail on a SIBLING worker's
  // half-written route and burn its retry budget on a problem it cannot fix.
  // Each case below breaks the "about" route and asserts that a "home"-scoped
  // run stays clean while an "about"-scoped run still catches it.
  function twoRouteProject(aboutSection: string, aboutMock = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "gate-scope-"));
    mkdirSync(join(dir, "src", "pages", "home", "sections"), { recursive: true });
    mkdirSync(join(dir, "src", "pages", "about", "sections"), { recursive: true });
    mkdirSync(join(dir, "src", "shell"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, nodes: {} }));
    writeFileSync(
      join(dir, "src", "shell", "routes.ts"),
      'export const routes = [{ slug: "home", path: "/", title: "Home" }];\n',
    );
    writeFileSync(
      join(dir, "src", "pages", "home", "sections", "Hero.tsx"),
      "export default function Hero({ headline }: { headline: string }) {\n" +
        "  return <section>{headline}</section>;\n}\n",
    );
    writeFileSync(join(dir, "src", "pages", "about", "sections", "AboutIntro.tsx"), aboutSection);
    if (aboutMock !== "") {
      mkdirSync(join(dir, "src", "pages", "about", "mock"), { recursive: true });
      writeFileSync(join(dir, "src", "pages", "about", "mock", "AboutIntro.data.ts"), aboutMock);
    }
    return dir;
  }

  function expectContained(dir: string, gate: number): void {
    // unscoped (the final whole-project run) still sees it
    expect(failuresOf(runGates(dir), gate).length).toBeGreaterThan(0);
    // the innocent sibling is not blamed
    expect(failuresOf(runGates(dir, { scopeRoute: "home" }), gate)).toEqual([]);
    // the owning route still is
    expect(failuresOf(runGates(dir, { scopeRoute: "about" }), gate).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  }

  it("gate 1: an unresolvable import on another route", () => {
    expectContained(
      twoRouteProject(
        'import { missing } from "./nope";\nexport default function AboutIntro() {\n  return <section>{missing}</section>;\n}\n',
      ),
      1,
    );
  });

  it("gate 2: a dangling href on another route", () => {
    expectContained(
      twoRouteProject(
        'export default function AboutIntro() {\n  return <a href="/not-a-route">x</a>;\n}\n',
      ),
      2,
    );
  });

  it("gate 3: a raw hex colour on another route", () => {
    expectContained(
      twoRouteProject(
        'export default function AboutIntro() {\n  return <section style={{ color: "#ff0000" }} />;\n}\n',
      ),
      3,
    );
  });

  it("gate 5: a hardcoded user-visible string on another route", () => {
    expectContained(
      twoRouteProject(
        "export default function AboutIntro() {\n  return <section>Welcome to Acme</section>;\n}\n",
      ),
      5,
    );
  });

  it("gate 6: a cross-page import on another route", () => {
    expectContained(
      twoRouteProject(
        'import Hero from "../../home/sections/Hero";\nexport default function AboutIntro() {\n  return <Hero headline="x" />;\n}\n',
      ),
      6,
    );
  });

  it("a scoped run still reports the scoped route's OWN problems across every gate", () => {
    // containment must not become blindness: the owning worker sees everything
    const dir = twoRouteProject(
      'import { missing } from "./nope";\nexport default function AboutIntro() {\n' +
        '  return <section style={{ color: "#ff0000" }}><a href="/not-a-route">Welcome to Acme</a>{missing}</section>;\n}\n',
    );
    const report = runGates(dir, { scopeRoute: "about" });
    for (const gate of [1, 2, 3, 5]) {
      expect(failuresOf(report, gate).length, `gate ${String(gate)}`).toBeGreaterThan(0);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("shared files are outside every page's scope, so no page worker is blamed for them", () => {
    // src/shell is the Shell Agent's, validated by its own step; a page
    // worker must not fail because of it.
    const dir = twoRouteProject("export default function AboutIntro() {\n  return <section />;\n}\n");
    writeFileSync(join(dir, "src", "shell", "Nav.tsx"), 'export const c = "#ff0000";\n');
    expect(failuresOf(runGates(dir, { scopeRoute: "home" }), 3)).toEqual([]);
    expect(failuresOf(runGates(dir, { scopeRoute: "about" }), 3)).toEqual([]);
    // ...but the whole-project run does catch it
    expect(failuresOf(runGates(dir), 3).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
