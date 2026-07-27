/**
 * Regeneration UX (PRD section 4, items 1-5) against the mock regen backend
 * (WG_REGEN_MOCK=1 in the preview webServer): deterministic transformations
 * mirroring the real contract — the real engine is covered by the 4.1 live
 * checks and the 4.3 stress suite.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, selectNode, waitForSaved } from "./helpers";

const ACCENT_RGB = "rgb(79, 70, 229)";

async function styleOverrideHeadline(page: Page): Promise<void> {
  await selectNode(page, "home.hero.headline");
  await page.getByTestId("swatch-color-color.semantic.accent").click();
  await waitForSaved(page);
}

async function startRegen(page: Page, instruction?: string): Promise<void> {
  await selectNode(page, "home.hero");
  await page.getByTestId("regen-button").click();
  const box = page.getByTestId("regen-instruction");
  await expect(box).toBeVisible();
  // pre-filled with the section's (canned) planner brief
  await expect(box).toHaveValue(/hero/i);
  // cost estimate shown before confirming
  await expect(page.getByTestId("regen-cost")).toContainText("30k");
  if (instruction !== undefined) {
    await box.fill(instruction);
  }
  await page.getByTestId("regen-confirm").click();
}

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

test("full regen round-trip: progress, surviving override re-applied, revert", async ({ page }) => {
  await styleOverrideHeadline(page);
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color))
    .toBe(ACCENT_RGB);

  await startRegen(page, "Make the headline about momentum.");

  // in-place progress over the section while the run is live
  await expect(page.getByTestId("regen-progress")).toBeVisible();
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  // new copy rendered...
  await expect(headline).toContainText("Regenerated:", { timeout: 15_000 });
  // ...and the surviving override visibly re-applied WITHOUT user action
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
    .toBe(ACCENT_RGB);

  // revert regeneration: original copy returns, override still applied
  await page.getByTestId("revert-regen-button").click();
  await expect(headline).not.toContainText("Regenerated:", { timeout: 15_000 });
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
    .toBe(ACCENT_RGB);
});

test("orphaned override dialog: lists exactly the lost edit, discard clears it", async ({ page }) => {
  // put an override on the node the regen will remove
  await selectNode(page, "home.hero.subheadline");
  await page.getByTestId("swatch-color-color.semantic.accent").click();
  await waitForSaved(page);

  await startRegen(page, "Please remove the subheadline entirely.");
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  const dialog = page.getByTestId("orphan-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("home.hero.subheadline");
  await expect(page.getByTestId("orphan-item")).toHaveCount(1);
  await expect(page.getByTestId("orphan-copy")).toBeVisible();

  await page.getByTestId("orphan-discard").click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  // the subheadline element is gone from the preview
  await expect(
    previewFrameLocator(page).locator('[data-node-id="home.hero.subheadline"]'),
  ).toHaveCount(0);
});

test("failed regen surfaces the report with a try-again affordance", async ({ page }) => {
  await startRegen(page, "FAIL this one please.");
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  const failure = page.getByTestId("regen-failure");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Raw hex color");
  await page.getByTestId("regen-try-again").click();
  await expect(page.getByTestId("regen-instruction")).toBeVisible();
});
