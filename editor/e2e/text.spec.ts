import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, waitForSaved } from "./helpers";

const overridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/home.overrides.json", import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

test("double-click opens an inline editable overlay pre-filled with the current text", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const original = (await headline.textContent())!;

  await headline.dblclick();
  const overlay = page.getByTestId("text-edit-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveText(original);
});

test("Enter commits on a single-line element (Heading) and updates the preview", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await headline.dblclick();
  await page.getByTestId("text-edit-overlay").fill("A brand new headline");
  await page.getByTestId("text-edit-overlay").press("Enter");

  await expect(page.getByTestId("text-edit-overlay")).toHaveCount(0);
  await expect(headline).toHaveText("A brand new headline");
  await waitForSaved(page);

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual([
    expect.objectContaining({
      nodeId: "home.hero.headline",
      channel: "text",
      value: "A brand new headline",
    }),
  ]);
});

test("blur commits", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await headline.dblclick();
  await page.getByTestId("text-edit-overlay").fill("Committed on blur");
  await page.getByTestId("text-edit-overlay").blur();

  await expect(page.getByTestId("text-edit-overlay")).toHaveCount(0);
  await expect(headline).toHaveText("Committed on blur");
});

test("Escape cancels without writing an override", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const original = (await headline.textContent())!;

  await headline.dblclick();
  await page.getByTestId("text-edit-overlay").fill("This should be discarded");
  await page.getByTestId("text-edit-overlay").press("Escape");

  await expect(page.getByTestId("text-edit-overlay")).toHaveCount(0);
  await expect(headline).toHaveText(original);

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual([]);
});

test("edits persist across reload", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await headline.dblclick();
  await page.getByTestId("text-edit-overlay").fill("Survives a reload");
  await page.getByTestId("text-edit-overlay").press("Enter");
  await waitForSaved(page);

  await page.reload();
  await openEditor(page);
  await expect(previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]')).toHaveText(
    "Survives a reload",
  );
});

test("undo reverts the text edit; redo reapplies it", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const original = (await headline.textContent())!;

  await headline.dblclick();
  await page.getByTestId("text-edit-overlay").fill("Undo me");
  await page.getByTestId("text-edit-overlay").press("Enter");
  await expect(headline).toHaveText("Undo me");

  await page.getByTestId("undo-button").click();
  await expect(headline).toHaveText(original);

  await page.getByTestId("redo-button").click();
  await expect(headline).toHaveText("Undo me");
});

test("Shift+Enter inserts a newline on a multi-line element (Text) instead of committing", async ({ page }) => {
  // home.hero.eyebrow, not subheadline: regen.spec.ts's "orphaned override"
  // test deliberately regenerates the hero section with subheadline removed,
  // and that write persists in the shared e2e project for the rest of the
  // suite run — eyebrow is the other Text-typed, text-editable node hero has.
  const eyebrow = previewFrameLocator(page).locator('[data-node-id="home.hero.eyebrow"]');
  await eyebrow.dblclick();
  const overlay = page.getByTestId("text-edit-overlay");
  await overlay.pressSequentially("Line one");
  await overlay.press("Enter"); // plain Enter on a multi-line element inserts a newline
  await overlay.pressSequentially("Line two");
  await expect(overlay).toBeVisible(); // still editing — plain Enter did not commit

  await overlay.press("Shift+Enter");
  await expect(overlay).toHaveCount(0);
  await expect(eyebrow).toContainText("Line one");
  await expect(eyebrow).toContainText("Line two");
});
