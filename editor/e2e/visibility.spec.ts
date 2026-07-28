import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, selectNode, waitForSaved } from "./helpers";

const overridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/home.overrides.json", import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

test("the eye toggle hides the node (ghosted, not removed) and persists an override", async ({ page }) => {
  await selectNode(page, "home.hero.eyebrow");
  const toggle = page.getByTestId("visibility-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  const eyebrow = previewFrameLocator(page).locator('[data-node-id="home.hero.eyebrow"]');
  await expect(eyebrow).toBeVisible(); // ghosted, still visible/selectable in edit mode
  await expect.poll(() => eyebrow.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.35");

  await waitForSaved(page);
  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: "home.hero.eyebrow", channel: "visibility", value: true }),
    ]),
  );
});

test("clicking the toggle again shows the node", async ({ page }) => {
  await selectNode(page, "home.hero.eyebrow");
  const toggle = page.getByTestId("visibility-toggle");
  await toggle.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  const eyebrow = previewFrameLocator(page).locator('[data-node-id="home.hero.eyebrow"]');
  await expect.poll(() => eyebrow.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});

test("switching to interact mode fully hides a hidden node and clears the selection; switching back to edit restores ghosting", async ({
  page,
}) => {
  await selectNode(page, "home.hero.eyebrow");
  await page.getByTestId("visibility-toggle").click();
  const eyebrow = previewFrameLocator(page).locator('[data-node-id="home.hero.eyebrow"]');
  await expect(eyebrow).toBeVisible();

  await page.getByTestId("mode-interact").click();
  await expect(eyebrow).toBeHidden();
  // interact mode disables editing (PRD 2.2): selection clears, inspector empties
  await expect(page.getByTestId("inspector")).not.toContainText("home.hero.eyebrow");

  await page.getByTestId("mode-edit").click();
  await expect(eyebrow).toBeVisible();
  await expect.poll(() => eyebrow.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.35");
});

test("undo reverts a visibility toggle; redo reapplies it", async ({ page }) => {
  await selectNode(page, "home.hero.eyebrow");
  const toggle = page.getByTestId("visibility-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("undo-button").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("redo-button").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("edits persist across reload", async ({ page }) => {
  await selectNode(page, "home.hero.eyebrow");
  await page.getByTestId("visibility-toggle").click();
  await waitForSaved(page);

  await page.reload();
  await openEditor(page);
  await selectNode(page, "home.hero.eyebrow");
  await expect(page.getByTestId("visibility-toggle")).toHaveAttribute("aria-pressed", "true");
});
