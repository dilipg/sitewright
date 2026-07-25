import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "../src/shim/protocol.ts";

const manifestPath = fileURLToPath(
  new URL("../../fixtures/acme-landing/manifest.json", import.meta.url),
);
const manifestNodeIds = Object.keys(
  (JSON.parse(readFileSync(manifestPath, "utf8")) as { nodes: Record<string, unknown> }).nodes,
).sort();

declare global {
  interface Window {
    __shimMessages: Array<{ type: string; [key: string]: unknown }>;
    __marker?: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__shimMessages = [];
    window.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string") {
        window.__shimMessages.push(data as { type: string });
      }
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__shimMessages.some((m) => m.type === "frame:ready"));
});

function latestMessage(page: Page, type: string) {
  return page.evaluate(
    (t) => [...window.__shimMessages].reverse().find((m) => m.type === t),
    type,
  );
}

function applyOverrides(page: Page, overrides: Array<Record<string, unknown>>, version = PROTOCOL_VERSION) {
  return page.evaluate(
    ({ overrides: list, version: v }) =>
      window.postMessage({ type: "overrides:apply", protocolVersion: v, overrides: list }, "*"),
    { overrides, version },
  );
}

function setMode(page: Page, mode: "edit" | "interact") {
  return page.evaluate(
    (m) => window.postMessage({ type: "mode:set", protocolVersion: 1, mode: m }, "*"),
    mode,
  );
}

test("frame:ready handshake carries the protocol version", async ({ page }) => {
  const ready = await latestMessage(page, "frame:ready");
  expect(ready?.["protocolVersion"]).toBe(PROTOCOL_VERSION);
});

test("geometry report covers every manifest node with non-empty rects", async ({ page }) => {
  await page.waitForFunction(() => window.__shimMessages.some((m) => m.type === "nodes:geometry"));
  const geometry = (await latestMessage(page, "nodes:geometry")) as
    | { nodes: Array<{ nodeId: string; rect: { width: number; height: number } }> }
    | undefined;
  const reportedIds = geometry!.nodes.map((n) => n.nodeId).sort();
  expect(reportedIds).toEqual(manifestNodeIds);
  for (const node of geometry!.nodes) {
    expect(node.rect.width, `${node.nodeId} width`).toBeGreaterThan(0);
    expect(node.rect.height, `${node.nodeId} height`).toBeGreaterThan(0);
  }
});

test("style override applies via injected stylesheet", async ({ page }) => {
  await applyOverrides(page, [
    { nodeId: "home.hero", channel: "style", value: { background: "color.semantic.accent" } },
  ]);
  const section = page.locator('[data-node-id="home.hero"]');
  // color.semantic.accent -> --color-semantic-accent -> #4f46e5
  await expect
    .poll(() => section.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe("rgb(79, 70, 229)");
});

test("layout override applies token-resolved values", async ({ page }) => {
  await applyOverrides(page, [
    { nodeId: "home.hero.headline", channel: "layout", value: { marginTop: "space.8" } },
  ]);
  const headline = page.locator('[data-node-id="home.hero.headline"]');
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).marginTop))
    .toBe("32px");
});

test("text override substitutes content and an empty list restores the original", async ({ page }) => {
  const headline = page.locator('[data-node-id="home.hero.headline"]');
  const original = await headline.textContent();

  await applyOverrides(page, [
    { nodeId: "home.hero.headline", channel: "text", value: "Hello from the shim" },
  ]);
  await expect(headline).toHaveText("Hello from the shim");

  await applyOverrides(page, []);
  await expect(headline).toHaveText(original!);
});

test("visibility override hides the element", async ({ page }) => {
  const subheadline = page.locator('[data-node-id="home.hero.subheadline"]');
  await expect(subheadline).toBeVisible();
  await applyOverrides(page, [
    { nodeId: "home.hero.subheadline", channel: "visibility", value: true },
  ]);
  await expect(subheadline).toBeHidden();
});

test("edit mode suppresses navigation and forwards node hits", async ({ page }) => {
  await page.evaluate(() => {
    window.__marker = 1;
  });

  // brand link in the nav navigates to "/" — suppressed in edit mode (default)
  await page.locator("header a").first().click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__marker)).toBe(1);

  await page.locator('[data-node-id="home.hero.headline"]').click();
  await page.waitForFunction(() =>
    window.__shimMessages.some((m) => m.type === "node:hit" && m["nodeId"] === "home.hero.headline"),
  );
  const hit = (await latestMessage(page, "node:hit")) as { kind: string } | undefined;
  expect(hit?.kind).toBe("click");
});

test("interact mode restores real navigation", async ({ page }) => {
  await page.evaluate(() => {
    window.__marker = 1;
  });
  await setMode(page, "interact");
  await page.locator("header a").first().click();
  await page.waitForLoadState("load");
  // real navigation reloaded the page, wiping the marker
  expect(await page.evaluate(() => window.__marker)).toBeUndefined();
});
