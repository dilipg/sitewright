/**
 * Prompt-driven editing against the mock operation source (WG_REGEN_MOCK=1).
 * The model is stubbed; what is under test is the editor's contract — apply,
 * reject, clarify, defer, and one undo entry per prompt.
 */
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, waitForSaved } from "./helpers";

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

async function prompt(page: import("@playwright/test").Page, instruction: string): Promise<void> {
  await page.getByTestId("edit-prompt-input").fill(instruction);
  await page.getByTestId("edit-prompt-submit").click();
}

test("a prompt applies overrides and summarises what changed", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await prompt(page, "make the headline shorter");

  await expect(page.getByTestId("edit-prompt-summary")).toBeVisible({ timeout: 20_000 });
  await expect(headline).toHaveText("A shorter headline", { timeout: 15_000 });
  await waitForSaved(page);
});

test("one prompt is one undo entry", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";
  await prompt(page, "make the headline shorter");
  await expect(headline).toHaveText("A shorter headline", { timeout: 20_000 });

  await page.getByTestId("edit-prompt-undo").click();
  await expect(headline).toHaveText(before, { timeout: 15_000 });
});

test("an invalid operation applies nothing and says why", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";
  await prompt(page, "INVALID");

  await expect(page.getByTestId("edit-prompt-errors")).toContainText("does-not-exist", { timeout: 20_000 });
  await expect(headline).toHaveText(before);
});

test("an ambiguous prompt asks instead of guessing", async ({ page }) => {
  await prompt(page, "make the button green");
  await expect(page.getByTestId("edit-prompt-clarify")).toContainText(/which button/i, { timeout: 20_000 });
});

test("a structural request defers to the paid flow rather than spending", async ({ page }) => {
  await prompt(page, "add a testimonials section");
  await expect(page.getByTestId("edit-prompt-structural")).toContainText(/generates new content/i, { timeout: 20_000 });
});
