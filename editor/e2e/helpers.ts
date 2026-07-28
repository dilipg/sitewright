import type { Frame, FrameLocator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PREVIEW = "http://localhost:5273";

export function previewFrameLocator(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="preview-home"]');
}

/** Every route gets its own iframe, titled "preview-<slug>" (App.tsx). */
export function routeFrameLocator(page: Page, slug: string): FrameLocator {
  return page.frameLocator(`iframe[title="preview-${slug}"]`);
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

/** Click-select a node through its route's own frame; section roots are hit via their padding area. */
export async function selectNode(page: Page, nodeId: string): Promise<void> {
  const frame = routeFrameLocator(page, nodeId.split(".")[0]!);
  if (nodeId === "home.hero") {
    await frame.locator('[data-node-id="home.hero"] > div').first().click({ position: { x: 8, y: 8 } });
  } else {
    await frame.locator(`[data-node-id="${nodeId}"]`).click();
  }
  // Assert THIS node ended up selected, not just that some selection-outline
  // is visible: a caller that selects several nodes in one session (the
  // invariant suite) can already have an outline on screen from the
  // PREVIOUS node, which would make a bare toBeVisible() check pass before
  // React actually commits the new selection — a real race for any action
  // (e.g. a drag) that follows immediately and closes over selectedId.
  await expect(page.locator(".inspector-id")).toHaveText(nodeId);
}

export async function resetOverrides(page: Page): Promise<void> {
  await page.request.put(`${PREVIEW}/__overrides/home`, {
    data: { version: 1, route: "/", overrides: [] },
  });
  await page.request.put(`${PREVIEW}/__overrides/about`, {
    data: { version: 1, route: "/about", overrides: [] },
  });
  await page.request.put(`${PREVIEW}/__overrides-history`, {
    data: { version: 1, snapshots: [{}], index: 0 },
  });
}

export async function waitForSaved(page: Page): Promise<void> {
  // The debounced save (300ms) can complete faster than this poll catches
  // the transient "Saving…" state — especially under heavier system load
  // (this got measurably more likely once the invariant suite made the
  // full e2e run much longer). Simply falling through to check "Saved"
  // when that happens is NOT safe on its own: "Saved" is also the state
  // left over from any EARLIER, unrelated save (e.g. the initial page
  // load), so checking it immediately can pass against stale text before
  // this edit's own debounce timer has even fired — the caller then
  // reloads before the edit is actually on disk. If we don't observe
  // "Saving…", fall back to waiting out the app's own known debounce
  // window instead, so "Saved" is only ever checked once THIS edit's save
  // cycle has definitely started.
  try {
    await expect(page.getByTestId("save-status")).toHaveText("Saving…", { timeout: 1000 });
  } catch {
    // Generous margin over the 300ms debounce: under the heavier system
    // load of the full suite, the debounce timer's own callback can fire
    // late too, not just be missed by this poll.
    await page.waitForTimeout(1000);
  }
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
