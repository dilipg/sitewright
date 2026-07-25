import type { FrameLocator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

function previewFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="preview"]');
}

async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  // the frame is attached and the app has geometry once the headline is visible
  await expect(previewFrame(page).locator('[data-node-id="home.hero.headline"]')).toBeVisible();
}

test("click hero headline selects it with the correct breadcrumb and channel badges", async ({ page }) => {
  await openEditor(page);
  await previewFrame(page).locator('[data-node-id="home.hero.headline"]').click();

  await expect(page.getByTestId("selection-outline")).toBeVisible();
  const breadcrumb = page.getByTestId("breadcrumb");
  await expect(breadcrumb).toContainText("Home");
  await expect(breadcrumb).toContainText("Hero");
  await expect(breadcrumb).toContainText("Headline");

  const badges = page.getByTestId("channel-badge");
  await expect(badges).toHaveText(["text", "style", "layout", "visibility"]);
});

test("Esc walks up from the headline to the hero section", async ({ page }) => {
  await openEditor(page);
  await previewFrame(page).locator('[data-node-id="home.hero.headline"]').click();
  await expect(page.getByTestId("breadcrumb")).toContainText("Headline");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("breadcrumb")).toContainText("Hero");
  await expect(page.getByTestId("breadcrumb")).not.toContainText("Headline");
  await expect(page.getByTestId("selection-outline")).toBeVisible();

  // one more Esc reaches page scope: selection cleared
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selection-outline")).toHaveCount(0);
});

test("clicking an unaddressable element selects the nearest addressable ancestor", async ({ page }) => {
  await openEditor(page);
  // the Container div inside the hero has no node id; a click in its padding
  // area targets it, and selection resolves to the hero section
  await previewFrame(page)
    .locator('[data-node-id="home.hero"] > div')
    .first()
    .click({ position: { x: 8, y: 8 } });

  await expect(page.getByTestId("selection-outline")).toBeVisible();
  await expect(page.getByTestId("breadcrumb")).toContainText("Hero");
  await expect(page.getByTestId("breadcrumb")).not.toContainText("Headline");
});

test("hover shows an outline with the human-readable node label", async ({ page }) => {
  await openEditor(page);
  await previewFrame(page).locator('[data-node-id="home.hero.cta-primary"]').hover();

  await expect(page.getByTestId("hover-outline")).toBeVisible();
  await expect(page.getByTestId("hover-label")).toHaveText("CTA Primary");
});

test("breadcrumb crumbs are clickable and select their node", async ({ page }) => {
  await openEditor(page);
  await previewFrame(page).locator('[data-node-id="home.hero.headline"]').click();
  await expect(page.getByTestId("breadcrumb")).toContainText("Headline");

  await page.getByTestId("breadcrumb").getByRole("button", { name: "Hero" }).click();
  await expect(page.getByTestId("breadcrumb")).not.toContainText("Headline");
  await expect(page.getByTestId("inspector")).toContainText("home.hero");
});
