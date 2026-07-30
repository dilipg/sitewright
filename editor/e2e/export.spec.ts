/**
 * Export flow e2e (PRD section 5, build prompt 6.2): the Export button ->
 * file-tree preview + HANDOVER.md + download, and the loud failure surface.
 *
 * The verification build is skipped here (WG_EXPORT_SKIP_BUILD, set on the
 * preview webServer in playwright.config.ts): gates still run, so this
 * exercises the real compilation path, but a full production build per test
 * would put minutes on every CI run. Build-failure reporting is covered by
 * exporter unit tests, and the real build runs in the invariant suite.
 */
import { expect, test } from "@playwright/test";
import { openEditor, resetOverrides, selectNode, waitForSaved } from "./helpers";

test.describe.configure({ mode: "serial" });

test.use({ viewport: { width: 1700, height: 900 } });

test("export produces a downloadable package with a file tree and HANDOVER.md", async ({ page }) => {
  test.setTimeout(120_000);
  await resetOverrides(page);
  await openEditor(page);

  await page.getByTestId("export-button").click();

  const panel = page.getByTestId("export-panel");
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("export-success-title")).toBeVisible();

  // file tree lists real source paths and excludes dependencies/build output
  const tree = page.getByTestId("export-file-tree");
  await expect(tree).toContainText("HANDOVER.md");
  await expect(tree).toContainText("Hero.tsx");
  await expect(tree).not.toContainText("node_modules");

  // HANDOVER.md tab shows the generated doc, including the integration seam
  await page.getByTestId("export-tab-handover").click();
  const handover = page.getByTestId("export-handover");
  await expect(handover).toContainText("# Handover");
  await expect(handover).toContainText("Integration TODOs");
  await expect(handover).toContainText("onSubmit");

  // the download link points at the archive endpoint and names the zip
  const download = page.getByTestId("export-download");
  await expect(download).toHaveAttribute("href", /__export-download$/);
  await expect(download).toContainText(".zip");
});

test("the export archive downloads and is a real zip", async ({ page }) => {
  test.setTimeout(120_000);
  await openEditor(page);
  // the previous test already exported; fetch the archive directly
  const response = await page.request.get("http://localhost:5273/__export-download");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/zip");
  const body = await response.body();
  // local file header signature "PK\x03\x04"
  expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
});

test("an edit made before export is compiled into the exported source", async ({ page }) => {
  test.setTimeout(120_000);
  await resetOverrides(page);
  await openEditor(page);

  await selectNode(page, "home.hero");
  await page.getByTestId("swatch-background-color.semantic.accent").click();
  await waitForSaved(page);

  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("export-summary")).toContainText("1 edit");
});

test("a failing export is loud: the panel names the cause and offers a retry", async ({ page }) => {
  test.setTimeout(120_000);
  await resetOverrides(page);
  await openEditor(page);

  // A style override naming a token that does not exist in tokens.css cannot
  // compile; the exporter refuses it rather than shipping degraded code
  // (contract 7.4). Seeded into the HISTORY file, not the override file: the
  // editor hydrates its state from history, so an override file written
  // behind its back is overwritten by the pre-export flush.
  await page.request.put("http://localhost:5273/__overrides-history", {
    data: {
      version: 1,
      snapshots: [{ "home.hero": { style: { background: "color.semantic.nonexistent" } } }],
      index: 0,
    },
  });
  await page.reload();
  await expect(
    page.frameLocator('iframe[title="preview-home"]').locator('[data-node-id="home.hero.headline"]'),
  ).toBeVisible();

  await page.getByTestId("export-button").click();

  await expect(page.getByTestId("export-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("export-failed-title")).toBeVisible();
  // the specific offending value, not a generic "export failed"
  await expect(page.getByTestId("export-failure-message")).toContainText(
    "color.semantic.nonexistent",
  );
  await expect(page.getByTestId("export-retry")).toBeVisible();
  // and no success affordance is offered alongside the failure
  await expect(page.getByTestId("export-download")).toHaveCount(0);

  await resetOverrides(page);
});
