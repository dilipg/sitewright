/**
 * The invariant suite (PRD 7.1) — the enforcement mechanism for the
 * product's one unforgivable failure: preview ≠ handover.
 *
 * Flow (serial): apply every case's edits through real editor UI →
 * screenshot each case's node in the edited preview → exportProject via
 * the real CLI (gates + typecheck + production build) → serve the built
 * export → screenshot the same nodes (data-node-id attributes survive the
 * build) → pixel-diff. Runs in CI via `npm run check`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PREVIEW, openEditor, resetOverrides, waitForSaved } from "./helpers";
import { INVARIANT_CASES } from "./invariant-cases";

const compilerDir = fileURLToPath(new URL("../../compiler", import.meta.url));
// Soak runs (3.4+) point the suite at a generated project via env
const projectDir =
  process.env.WG_PROJECT_DIR ??
  fileURLToPath(new URL("../../generated/editor-e2e-project", import.meta.url));
const exportDir =
  process.env.WG_EXPORT_DIR ??
  fileURLToPath(new URL("../../generated/invariant-export", import.meta.url));
const EXPORT_PORT = 5390;

/** Max fraction of differing pixels. Same browser, same widths — headroom is for antialiasing only. */
const MAX_DIFF_RATIO = 0.01;

const previewShots = new Map<string, Buffer>();
const exportShots = new Map<string, Buffer>();

// Every InvariantCase's screenshotNode belongs to exactly one route (its
// first dot-segment). The suite started home-only (M3-5.4); milestone 6.1's
// contact-form case is the first to live on a different route, so the
// preview-capture and export-verification steps below now loop per route
// instead of assuming "home" everywhere. ROUTE_READY_MARKER mirrors the
// original single-route wait: each route's own STYLE case's override target
// (not necessarily its screenshotNode — see cta-band/contact-form, which
// screenshot a child instead of the styled section root) is guaranteed to
// land in the shim's injected stylesheet once overrides have actually
// applied, so waiting for that substring is a real condition, not a guess.
const ROUTE_PATHS: Record<string, string> = { home: "/", about: "/about", support: "/support" };
/**
 * How to know a route's overrides have actually applied before screenshotting.
 *
 * A style/layout override lands in the shim's injected stylesheet, so waiting
 * for the node id to appear there is a real condition. A route whose only
 * override is TEXT-channel injects no stylesheet at all — "about" carries just
 * the image-replace case (PRD 3.5: image replace IS the text channel) — so it
 * waits on the DOM effect itself instead.
 */
type ReadyCheck =
  | { kind: "stylesheet"; marker: string }
  | { kind: "attribute"; selector: string; attribute: string; startsWith: string };

const ROUTE_READY: Record<string, ReadyCheck> = {
  home: { kind: "stylesheet", marker: "home.hero" },
  about: {
    kind: "attribute",
    selector: '[data-node-id="about.intro.portrait"]',
    attribute: "src",
    startsWith: "data:image/svg+xml",
  },
  support: { kind: "stylesheet", marker: "support.contact-form" },
};

function routeSlugOf(nodeId: string): string {
  return nodeId.split(".")[0]!;
}

function casesByRoute(): Map<string, typeof INVARIANT_CASES> {
  const grouped = new Map<string, typeof INVARIANT_CASES>();
  for (const invariantCase of INVARIANT_CASES) {
    const slug = routeSlugOf(invariantCase.screenshotNode);
    const existing = grouped.get(slug);
    if (existing === undefined) grouped.set(slug, [invariantCase]);
    else existing.push(invariantCase);
  }
  return grouped;
}

// The default 1280px viewport isn't wide enough for the 1280px-wide canvas
// stage plus the 280px inspector panel (same issue layout.spec.ts documents)
// — a layout-drag case's move-handle can fall outside the interactable
// viewport, or its click coordinates can resolve against a partially
// off-screen element. previewPage/exportPage (bare page loads of the actual
// site, not the editor) inherit the same viewport, which is fine: the
// comparison is preview vs export at matching width, not against a fixed
// absolute size.
test.use({ viewport: { width: 1700, height: 900 } });

test.describe.configure({ mode: "serial" });

test("apply all invariant-case edits in the editor and capture preview nodes", async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);

  for (const invariantCase of INVARIANT_CASES) {
    await invariantCase.apply(page);
  }
  await waitForSaved(page);

  // Capture from a bare preview page, symmetric with the export capture:
  // same viewport, no editor chrome or selection overlays above the frame.
  // The persisted overrides are applied through the same shim protocol the
  // editor uses. (Variant values would need editor-side expansion here —
  // cases stay variant-free until the exporter compiles variants, M5.) One
  // bare page per route: each route is a separate document, so a route's
  // own overrides file and its own "ready" marker only ever apply there.
  for (const [slug, cases] of casesByRoute()) {
    const routePath = ROUTE_PATHS[slug];
    if (routePath === undefined) throw new Error(`invariant-cases.ts: no ROUTE_PATHS entry for route "${slug}"`);
    const readyCheck = ROUTE_READY[slug];
    if (readyCheck === undefined) throw new Error(`invariant-cases.ts: no ROUTE_READY entry for route "${slug}"`);

    const overrideFile = JSON.parse(
      readFileSync(join(projectDir, "overrides", `${slug}.overrides.json`), "utf8"),
    ) as { overrides: unknown[] };

    const previewPage = await page.context().newPage();
    await previewPage.goto(`${PREVIEW}${routePath}`);
    // Confirms the route's own document has hydrated before posting
    // overrides (a postMessage sent before the shim's listener is
    // registered is simply lost) — any case's node in this route group
    // works as the signal, since all of them render regardless of overrides.
    await expect(previewPage.locator(`[data-node-id="${cases[0]!.screenshotNode}"]`)).toBeVisible();
    await previewPage.evaluate((overrides) => {
      window.postMessage({ type: "overrides:apply", protocolVersion: 1, overrides }, "*");
    }, overrideFile.overrides);
    await previewPage.waitForFunction(
      (check) =>
        check.kind === "stylesheet"
          ? document.querySelector("style[data-wg-shim]")?.textContent?.includes(check.marker) === true
          : document
              .querySelector(check.selector)
              ?.getAttribute(check.attribute)
              ?.startsWith(check.startsWith) === true,
      readyCheck,
    );

    for (const invariantCase of cases) {
      const locator = previewPage.locator(`[data-node-id="${invariantCase.screenshotNode}"]`);
      await locator.scrollIntoViewIfNeeded();
      previewShots.set(invariantCase.name, await locator.screenshot());
    }
    await previewPage.close();
  }
});

test("export builds and the same nodes render in the served export", async ({ page }) => {
  test.setTimeout(240_000);

  // no shell: the repo path contains a space, and shell:true would split
  // unquoted args; node is a real executable and needs no shell anyway
  const result = spawnSync(
    "node",
    ["scripts/export.ts", projectDir, exportDir, "--clean"],
    { cwd: compilerDir, encoding: "utf8", timeout: 200_000 },
  );
  expect(result.status, `export failed:\n${result.stdout}\n${result.stderr}`).toBe(0);

  const { preview } = await import("vite");
  // configFile:false — the export ships without node_modules, so its own
  // vite.config.ts must not be loaded; this is plain static serving of dist/
  const server = await preview({
    configFile: false,
    root: exportDir,
    preview: { port: EXPORT_PORT, strictPort: true },
  });
  try {
    for (const [slug, cases] of casesByRoute()) {
      const routePath = ROUTE_PATHS[slug];
      if (routePath === undefined) throw new Error(`invariant-cases.ts: no ROUTE_PATHS entry for route "${slug}"`);

      const exportPage = await page.context().newPage();
      await exportPage.goto(`http://localhost:${EXPORT_PORT}${routePath}`);
      for (const invariantCase of cases) {
        const locator = exportPage.locator(`[data-node-id="${invariantCase.screenshotNode}"]`);
        if (invariantCase.expectRemovedFromExport === true) {
          await expect(locator).toHaveCount(0);
          continue;
        }
        await expect(locator).toBeVisible();
        exportShots.set(invariantCase.name, await locator.screenshot());
      }
      await exportPage.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});

for (const invariantCase of INVARIANT_CASES) {
  if (invariantCase.expectRemovedFromExport === true) {
    test(`removed-from-export: ${invariantCase.name}`, () => {
      // The absence assertion already ran in the "export builds..." step
      // above (must happen before the export server closes); this test
      // exists so a visibility case still gets its own pass/fail line.
      expect(exportShots.has(invariantCase.name), "expected no export screenshot for a removed node").toBe(false);
    });
    continue;
  }
  test(`pixel-diff: ${invariantCase.name}`, () => {
    const previewShot = previewShots.get(invariantCase.name);
    const exportShot = exportShots.get(invariantCase.name);
    expect(previewShot, "preview screenshot missing (earlier step failed)").toBeDefined();
    expect(exportShot, "export screenshot missing (earlier step failed)").toBeDefined();

    const previewPng = PNG.sync.read(previewShot!);
    const exportPng = PNG.sync.read(exportShot!);
    expect(
      { width: exportPng.width, height: exportPng.height },
      "rendered box dimensions diverge between preview and export",
    ).toEqual({ width: previewPng.width, height: previewPng.height });

    const diffPng = new PNG({ width: previewPng.width, height: previewPng.height });
    const differing = pixelmatch(
      previewPng.data,
      exportPng.data,
      diffPng.data,
      previewPng.width,
      previewPng.height,
      { threshold: 0.2 },
    );
    const ratio = differing / (previewPng.width * previewPng.height);
    if (ratio >= MAX_DIFF_RATIO) {
      const artifactDir = fileURLToPath(new URL("../test-results/invariant-artifacts", import.meta.url));
      mkdirSync(artifactDir, { recursive: true });
      const slug = invariantCase.name.replace(/[^a-z0-9]+/gi, "-");
      writeFileSync(join(artifactDir, `${slug}-preview.png`), previewShot!);
      writeFileSync(join(artifactDir, `${slug}-export.png`), exportShot!);
      writeFileSync(join(artifactDir, `${slug}-diff.png`), PNG.sync.write(diffPng));
    }
    expect(ratio, `${(ratio * 100).toFixed(3)}% of pixels differ`).toBeLessThan(MAX_DIFF_RATIO);
  });
}
