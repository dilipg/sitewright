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

test("one prompt is one undo entry, even for a compound instruction touching two nodes", async ({ page }) => {
  // Every other mock branch returns at most one operation, which can't tell
  // "pushHistory once per prompt" apart from "once per operation" (1 op
  // either way = 1 push either way). This instruction returns two operations
  // on two distinct nodes, so a single undo reverting BOTH is the only way
  // to prove the whole prompt landed as one history entry.
  const eyebrow = previewFrameLocator(page).locator('[data-node-id="home.hero.eyebrow"]');
  const subheadline = previewFrameLocator(page).locator('[data-node-id="home.hero.subheadline"]');
  const eyebrowBefore = (await eyebrow.textContent()) ?? "";
  const subheadlineBefore = (await subheadline.textContent()) ?? "";

  await prompt(page, "update the eyebrow and the subhead");
  await expect(eyebrow).toHaveText("New eyebrow copy", { timeout: 20_000 });
  await expect(subheadline).toHaveText("New subheadline copy", { timeout: 15_000 });
  await expect(page.getByTestId("undo-button")).toBeEnabled();

  await page.getByTestId("edit-prompt-undo").click();
  await expect(eyebrow).toHaveText(eyebrowBefore, { timeout: 15_000 });
  await expect(subheadline).toHaveText(subheadlineBefore, { timeout: 15_000 });
  // history.index is back to 0 (undo-button disabled) after exactly ONE
  // undo — proof there was exactly one entry to undo, not two.
  await expect(page.getByTestId("undo-button")).toBeDisabled();
});

test("Enter is guarded like the submit button: a rapid double press sends one request", async ({
  page,
}) => {
  // Regression for the keyboard path bypassing the running/empty guard that
  // the submit button already has: without the guard, a fast double-Enter
  // (or OS key-repeat from holding it) calls submitEditPrompt() twice
  // concurrently, and each call reaches its own pushHistory — one prompt
  // would then produce two undo entries.
  //
  // The response is HELD until both presses have happened, and the request
  // count is asserted. Neither is optional: the mock endpoint answers in
  // milliseconds and the draft clears on success, so if the first request
  // finished between the presses, the second press would be stopped by the
  // EMPTY-value guard instead — and the test would pass with the running
  // guard deleted, which is the only thing it is here to check.
  let requests = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/__edit-prompt", async (route) => {
    requests += 1;
    await held;
    await route.continue();
  });

  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";
  const input = page.getByTestId("edit-prompt-input");

  await input.fill("make the headline shorter");
  await input.press("Enter");
  // in flight and visibly so: the guard the second press must hit
  await expect(page.getByTestId("edit-prompt-submit")).toHaveText("Working…");
  await input.press("Enter");
  expect(requests, "the second Enter must not reach the server").toBe(1);

  release();
  await expect(headline).toHaveText("A shorter headline", { timeout: 20_000 });
  await expect(page.getByTestId("undo-button")).toBeEnabled();
  // and still exactly one request, now that the first has completed
  expect(requests).toBe(1);

  await page.getByTestId("edit-prompt-undo").click();
  await expect(headline).toHaveText(before, { timeout: 15_000 });
  await expect(page.getByTestId("undo-button")).toBeDisabled();
});

test("an instruction that matches nothing applies no operations and says so", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";

  await prompt(page, "do something the mock has never heard of");
  await expect(page.getByTestId("edit-prompt-errors")).toContainText(/nothing to change/i, { timeout: 20_000 });
  await expect(headline).toHaveText(before);
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
