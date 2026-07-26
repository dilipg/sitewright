import type { Frame, FrameLocator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PREVIEW = "http://localhost:5273";

export function previewFrameLocator(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="preview"]');
}

export function previewFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(PREVIEW));
  if (frame === undefined) throw new Error("preview frame not found");
  return frame;
}

export async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]'),
  ).toBeVisible();
}

/** Click-select a node through the frame; section roots are hit via their padding area. */
export async function selectNode(page: Page, nodeId: string): Promise<void> {
  if (nodeId === "home.hero") {
    await previewFrameLocator(page)
      .locator('[data-node-id="home.hero"] > div')
      .first()
      .click({ position: { x: 8, y: 8 } });
  } else {
    await previewFrameLocator(page).locator(`[data-node-id="${nodeId}"]`).click();
  }
  await expect(page.getByTestId("selection-outline")).toBeVisible();
}

export async function resetOverrides(page: Page): Promise<void> {
  await page.request.put(`${PREVIEW}/__overrides/home`, {
    data: { version: 1, route: "/", overrides: [] },
  });
  await page.request.put(`${PREVIEW}/__overrides-history`, {
    data: { version: 1, snapshots: [{}], index: 0 },
  });
}

export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("save-status")).toHaveText("Saving…");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
