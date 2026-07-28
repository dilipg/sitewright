import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const PREVIEW = "http://localhost:5273";
const overridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/home.overrides.json", import.meta.url),
);

const ACCENT_RGB = "rgb(79, 70, 229)"; // color.semantic.accent -> #4f46e5
const BG_RGB = "rgb(248, 250, 252)"; // color.semantic.bg -> #f8fafc

function previewFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(PREVIEW));
  if (frame === undefined) throw new Error("preview frame not found");
  return frame;
}

async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.frameLocator('iframe[title="preview-home"]').locator('[data-node-id="home.hero.headline"]'),
  ).toBeVisible();
}

async function selectHero(page: Page): Promise<void> {
  await page
    .frameLocator('iframe[title="preview-home"]')
    .locator('[data-node-id="home.hero"] > div')
    .first()
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("breadcrumb")).toContainText("Hero");
}

async function heroBackground(page: Page): Promise<string> {
  return previewFrame(page).evaluate(() => {
    const element = document.querySelector('[data-node-id="home.hero"]');
    return element === null ? "" : getComputedStyle(element).backgroundColor;
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.put(`${PREVIEW}/__overrides/home`, {
    data: { version: 1, route: "/", overrides: [] },
  });
  await page.request.put(`${PREVIEW}/__overrides-history`, {
    data: { version: 1, snapshots: [{}], index: 0 },
  });
  await openEditor(page);
});

test("background swatch applies within the gesture-feedback ceiling", async ({ page }) => {
  await selectHero(page);

  await previewFrame(page).evaluate((target) => {
    const element = document.querySelector('[data-node-id="home.hero"]')!;
    (window as unknown as { __bgAppliedAt: number }).__bgAppliedAt = 0;
    const loop = () => {
      if (getComputedStyle(element).backgroundColor === target) {
        (window as unknown as { __bgAppliedAt: number }).__bgAppliedAt = Date.now();
      } else {
        requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
  }, ACCENT_RGB);

  const clickedAt = Date.now();
  await page.getByTestId("swatch-background-color.semantic.accent").click();

  await previewFrame(page).waitForFunction(
    () => (window as unknown as { __bgAppliedAt: number }).__bgAppliedAt > 0,
  );
  const appliedAt = await previewFrame(page).evaluate(
    () => (window as unknown as { __bgAppliedAt: number }).__bgAppliedAt,
  );
  // 100ms is the target; 250ms is the build-plan hard ceiling (kept as the
  // assertion bound for CI stability)
  expect(appliedAt - clickedAt).toBeLessThan(250);
});

test("edits persist across reload", async ({ page }) => {
  await selectHero(page);
  await page.getByTestId("swatch-background-color.semantic.accent").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saving…");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual([
    expect.objectContaining({
      nodeId: "home.hero",
      channel: "style",
      value: { background: "color.semantic.accent" },
    }),
  ]);

  await page.reload();
  await openEditor(page);
  await expect.poll(() => heroBackground(page)).toBe(ACCENT_RGB);
});

test("undo reverts visually and in the override file", async ({ page }) => {
  await selectHero(page);
  await page.getByTestId("swatch-background-color.semantic.accent").click();
  await expect(page.getByTestId("save-status")).toHaveText("Saving…");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await expect.poll(() => heroBackground(page)).toBe(ACCENT_RGB);

  await page.getByTestId("undo-button").click();
  await expect.poll(() => heroBackground(page)).toBe(BG_RGB);
  await expect(page.getByTestId("save-status")).toHaveText("Saving…");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual([]);
});

test("redo reapplies after undo", async ({ page }) => {
  await selectHero(page);
  await page.getByTestId("swatch-background-color.semantic.accent").click();
  await expect.poll(() => heroBackground(page)).toBe(ACCENT_RGB);
  await page.getByTestId("undo-button").click();
  await expect.poll(() => heroBackground(page)).toBe(BG_RGB);
  await page.getByTestId("redo-button").click();
  await expect.poll(() => heroBackground(page)).toBe(ACCENT_RGB);
});

test("off-scale custom value applies and shows the badge", async ({ page }) => {
  await selectHero(page);
  await page.getByTestId("custom-toggle-background").click();
  await page.getByTestId("custom-input-background").fill("#ff5500");
  await page.getByTestId("custom-input-background").press("Enter");

  await expect.poll(() => heroBackground(page)).toBe("rgb(255, 85, 0)");
  await expect(page.getByTestId("offscale-badge")).toBeVisible();
});

test("spacing stepper applies a token value and the spacing overlay renders", async ({ page }) => {
  await selectHero(page);
  await expect(page.getByTestId("spacing-overlay")).toBeVisible();

  await page.getByTestId("stepper-inc-padding").click();
  await expect
    .poll(() =>
      previewFrame(page).evaluate(() =>
        getComputedStyle(document.querySelector('[data-node-id="home.hero"]')!).paddingTop,
      ),
    )
    .toBe("24px"); // first step lands mid-scale: space.6 -> 1.5rem
});

test("variant switcher applies live through the shim", async ({ page }) => {
  await page
    .frameLocator('iframe[title="preview-home"]')
    .locator('[data-node-id="home.hero.cta-secondary"]')
    .click();
  await expect(page.getByTestId("breadcrumb")).toContainText("CTA Secondary");

  await page.getByTestId("variant-primary").click();
  await expect
    .poll(() =>
      previewFrame(page).evaluate(() =>
        getComputedStyle(document.querySelector('[data-node-id="home.hero.cta-secondary"]')!)
          .backgroundColor,
      ),
    )
    .toBe(ACCENT_RGB);
});
