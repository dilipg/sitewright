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
const projectDir = fileURLToPath(new URL("../../generated/editor-e2e-project", import.meta.url));
const exportDir = fileURLToPath(new URL("../../generated/invariant-export", import.meta.url));
const EXPORT_PORT = 5390;

/** Max fraction of differing pixels. Same browser, same widths — headroom is for antialiasing only. */
const MAX_DIFF_RATIO = 0.01;

const previewShots = new Map<string, Buffer>();
const exportShots = new Map<string, Buffer>();

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
  // cases stay variant-free until the exporter compiles variants, M5.)
  const overrideFile = JSON.parse(
    readFileSync(join(projectDir, "overrides", "home.overrides.json"), "utf8"),
  ) as { overrides: unknown[] };

  const previewPage = await page.context().newPage();
  await previewPage.goto(PREVIEW);
  await expect(previewPage.locator('[data-node-id="home.hero.headline"]')).toBeVisible();
  await previewPage.evaluate((overrides) => {
    window.postMessage({ type: "overrides:apply", protocolVersion: 1, overrides }, "*");
  }, overrideFile.overrides);
  await previewPage.waitForFunction(() =>
    document.querySelector("style[data-wg-shim]")?.textContent?.includes("home.hero"),
  );

  for (const invariantCase of INVARIANT_CASES) {
    const locator = previewPage.locator(`[data-node-id="${invariantCase.screenshotNode}"]`);
    await locator.scrollIntoViewIfNeeded();
    previewShots.set(invariantCase.name, await locator.screenshot());
  }
  await previewPage.close();
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
    const exportPage = await page.context().newPage();
    await exportPage.goto(`http://localhost:${EXPORT_PORT}/`);
    for (const invariantCase of INVARIANT_CASES) {
      const locator = exportPage.locator(`[data-node-id="${invariantCase.screenshotNode}"]`);
      await expect(locator).toBeVisible();
      exportShots.set(invariantCase.name, await locator.screenshot());
    }
    await exportPage.close();
  } finally {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});

for (const invariantCase of INVARIANT_CASES) {
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
