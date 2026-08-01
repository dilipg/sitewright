import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openEditor, PREVIEW, resetOverrides, routeFrameLocator, selectNode, waitForSaved } from "./helpers";

const aboutOverridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/about.overrides.json", import.meta.url),
);
const homeOverridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/home.overrides.json", import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
});

test.describe("wide viewport: both frames near the viewport, no panning needed", () => {
  test.use({ viewport: { width: 3000, height: 900 } });

  test("every route renders as its own frame, laid out side by side", async ({ page }) => {
    await openEditor(page);
    const home = page.getByTestId("frame-home");
    const about = page.getByTestId("frame-about");
    await expect(home).toBeVisible();
    await expect(about).toBeVisible();
    const homeBox = await home.boundingBox();
    const aboutBox = await about.boundingBox();
    expect(homeBox).not.toBeNull();
    expect(aboutBox).not.toBeNull();
    // about is laid out to the right of home (FRAME_WIDTH + FRAME_GAP apart), not stacked
    expect(aboutBox!.x).toBeGreaterThan(homeBox!.x + homeBox!.width);
    expect(Math.abs(aboutBox!.y - homeBox!.y)).toBeLessThan(2);
  });

  test("selecting a node on a non-home route works end to end through its own frame", async ({ page }) => {
    await openEditor(page);
    await selectNode(page, "about.intro.heading");
    await expect(page.getByTestId("breadcrumb")).toContainText("Heading");
  });

  test("editing a node on a non-home route persists to that route's own overrides file, not another route's", async ({
    page,
  }) => {
    await openEditor(page);
    const heading = routeFrameLocator(page, "about").locator('[data-node-id="about.intro.heading"]');
    await heading.dblclick();
    const overlay = page.getByTestId("text-edit-overlay");
    await overlay.fill("A new headline for the about page");
    await overlay.press("Enter");
    await waitForSaved(page);

    const aboutFile = JSON.parse(readFileSync(aboutOverridesFile, "utf8"));
    expect(aboutFile.overrides).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "about.intro.heading", channel: "text" })]),
    );
    const homeFile = JSON.parse(readFileSync(homeOverridesFile, "utf8"));
    expect(homeFile.overrides).toEqual([]);
  });

  test("wheel-panning the stage shifts frame position on screen", async ({ page }) => {
    await openEditor(page);
    const home = page.getByTestId("frame-home");
    const before = (await home.boundingBox())!;
    // y=60 sits in the stage's own background — above every frame (frames
    // start at the stage's initial 40px viewport offset) — never inside a
    // cross-origin iframe, which wouldn't bubble the wheel event to .stage.
    await page.mouse.move(100, 60);
    await page.mouse.wheel(120, 20);
    // boundingBox() is a one-shot snapshot, not a retrying assertion — poll
    // it until React's state update has actually flushed to the DOM.
    await expect
      .poll(async () => (await home.boundingBox())?.x)
      .toBeCloseTo(before.x - 120, 0);
    const after = (await home.boundingBox())!;
    expect(after.y).toBeCloseTo(before.y - 20, 0);
  });

  test("ctrl+wheel zooms the canvas (scale changes in the transform)", async ({ page }) => {
    await openEditor(page);
    const surface = page.getByTestId("canvas-surface");
    await expect(surface).toHaveAttribute("style", /scale\(1\)/);
    await page.mouse.move(100, 60);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await expect
      .poll(async () => {
        const style = await surface.getAttribute("style");
        return Number(/scale\(([\d.]+)\)/.exec(style ?? "")?.[1] ?? 1);
      })
      .toBeGreaterThan(1);
  });
});

test.describe("narrow viewport: the second frame starts outside virtualization range", () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test("a frame far outside the viewport renders a placeholder, not a live iframe, until panned into range", async ({
    page,
  }) => {
    await openEditor(page);
    const about = page.getByTestId("frame-about");
    await expect(about.locator(".frame-placeholder")).toBeVisible();
    await expect(about.locator('iframe[title="preview-about"]')).toHaveCount(0);

    // pan far enough left to bring the about frame into virtualization range
    // (y=60: stage background above the frames, never inside an iframe)
    await page.mouse.move(400, 60);
    await page.mouse.wheel(1200, 0);

    await expect(about.locator('iframe[title="preview-about"]')).toBeVisible();
    await expect(about.locator(".frame-placeholder")).toHaveCount(0);
  });
});

test("route override files round-trip through the __overrides API by slug", async ({ page }) => {
  const response = await page.request.get(`${PREVIEW}/__overrides/about`);
  const body = await response.json();
  expect(body.route).toBe("/about");
});

test.describe("responsive read-only preview (PRD 7 P1)", () => {
  test.use({ viewport: { width: 1700, height: 900 } });

  test("switching to a narrow width resizes the frames and turns editing off", async ({ page }) => {
    await openEditor(page);
    const home = page.getByTestId("frame-home");
    const desktopWidth = (await home.boundingBox())!.width;

    await page.getByTestId("width-mobile").click();
    const mobileWidth = (await home.boundingBox())!.width;
    expect(mobileWidth).toBeLessThan(desktopWidth);
    expect(Math.round(mobileWidth)).toBe(390);

    // read-only is stated, not just implied
    await expect(page.getByTestId("readonly-banner")).toBeVisible();

    // and selection is genuinely off: clicking a node selects nothing
    await page
      .frameLocator('iframe[title="preview-home"]')
      .locator('[data-node-id="home.hero.headline"]')
      .click();
    await expect(page.locator(".inspector-id")).toHaveCount(0);
  });

  test("returning to desktop restores editing", async ({ page }) => {
    await openEditor(page);
    await page.getByTestId("width-tablet").click();
    await expect(page.getByTestId("readonly-banner")).toBeVisible();

    await page.getByTestId("width-desktop").click();
    await expect(page.getByTestId("readonly-banner")).toHaveCount(0);
    await selectNode(page, "home.hero.headline");
    await expect(page.locator(".inspector-id")).toHaveText("home.hero.headline");
  });
});
