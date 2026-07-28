import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openEditor, previewFrame, resetOverrides, selectNode, waitForSaved } from "./helpers";

const overridesFile = fileURLToPath(
  new URL("../../generated/editor-e2e-project/overrides/home.overrides.json", import.meta.url),
);

// The default 1280px viewport isn't wide enough for the 1280px-wide preview
// stage PLUS the 280px inspector panel — a hero-section resize handle at the
// stage's right edge falls outside the interactable viewport.
test.use({ viewport: { width: 1700, height: 900 } });

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

async function heroMarginStyle(page: import("@playwright/test").Page) {
  return previewFrame(page).evaluate(() => {
    const el = document.querySelector('[data-node-id="home.hero"]')!;
    const computed = getComputedStyle(el);
    return { marginLeft: computed.marginLeft, marginTop: computed.marginTop };
  });
}

async function dragMoveHandle(page: import("@playwright/test").Page, dx: number, dy: number) {
  const box = (await page.getByTestId("move-handle").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // steps > 1: dispatches intermediate mousemove events rather than one
  // instant jump — a single-jump move reliably fails to register with the
  // window-level mousemove listener the drag gesture depends on.
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
}

test("dragging the move handle repositions the element via margin, snapped to the space scale", async ({ page }) => {
  await selectNode(page, "home.hero");
  // 20px raw -> snaps to space.4 (16px) against this fixture's token scale
  await dragMoveHandle(page, 20, 20);
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("drag-ghost")).toHaveCount(0);

  await expect.poll(() => heroMarginStyle(page)).toEqual({ marginLeft: "16px", marginTop: "16px" });
  await waitForSaved(page);

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: "home.hero", channel: "layout", value: { marginLeft: "16px", marginTop: "16px" } }),
    ]),
  );
});

test("the selection outline body stays click-through so a child inside it is still selectable", async ({ page }) => {
  await selectNode(page, "home.hero");
  // headline is a child of the hero section — well within the parent's
  // bounding box the (non-interactive) outline body covers
  await selectNode(page, "home.hero.headline");
  await expect(page.getByTestId("breadcrumb")).toContainText("Headline");
});

test("dragging the se handle resizes width and height", async ({ page }) => {
  await selectNode(page, "home.hero");
  const startBox = (await page.getByTestId("selection-outline").boundingBox())!;
  const handle = page.getByTestId("handle-se");
  const handleBox = (await handle.boundingBox())!;

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 20, handleBox.y + 20, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(() =>
      previewFrame(page).evaluate(
        () => getComputedStyle(document.querySelector('[data-node-id="home.hero"]')!).width,
      ),
    )
    .toBe(`${Math.round(startBox.width + 16)}px`);
});

test("holding Alt disables snapping — an off-scale raw pixel value applies", async ({ page }) => {
  await selectNode(page, "home.hero");
  const box = (await page.getByTestId("move-handle").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + box.width / 2 + 13, box.y + box.height / 2 + 5, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");

  await expect.poll(() => heroMarginStyle(page)).toEqual({ marginLeft: "13px", marginTop: "5px" });
});

test("a gesture exceeding the threshold is rejected: no override commits, and a hint appears", async ({ page }) => {
  await selectNode(page, "home.hero");
  const before = await heroMarginStyle(page);
  await dragMoveHandle(page, 400, 0);
  await expect(page.getByTestId("drag-ghost")).toHaveClass(/rejected/);
  await page.mouse.up();

  await expect(page.getByTestId("gesture-toast")).toHaveText("Regenerate the section to change its structure");
  await expect.poll(() => heroMarginStyle(page)).toEqual(before);

  const onDisk = JSON.parse(readFileSync(overridesFile, "utf8"));
  expect(onDisk.overrides).toEqual([]);
});

test("undo reverts a layout drag; redo reapplies it", async ({ page }) => {
  await selectNode(page, "home.hero");
  const before = await heroMarginStyle(page);
  await dragMoveHandle(page, 20, 20);
  await page.mouse.up();
  await expect.poll(() => heroMarginStyle(page)).toEqual({ marginLeft: "16px", marginTop: "16px" });

  await page.getByTestId("undo-button").click();
  await expect.poll(() => heroMarginStyle(page)).toEqual(before);

  await page.getByTestId("redo-button").click();
  await expect.poll(() => heroMarginStyle(page)).toEqual({ marginLeft: "16px", marginTop: "16px" });
});
