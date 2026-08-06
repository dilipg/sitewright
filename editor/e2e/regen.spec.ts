/**
 * Regeneration UX (PRD section 4, items 1-5) against the mock regen backend
 * (WG_REGEN_MOCK=1 in the preview webServer): deterministic transformations
 * mirroring the real contract — the real engine is covered by the 4.1 live
 * checks and the 4.3 stress suite.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, selectNode, waitForSaved } from "./helpers";

const ACCENT_RGB = "rgb(79, 70, 229)";

async function styleOverrideHeadline(page: Page): Promise<void> {
  await selectNode(page, "home.hero.headline");
  await page.getByTestId("swatch-color-color.semantic.accent").click();
  await waitForSaved(page);
}

async function startRegen(page: Page, instruction?: string): Promise<void> {
  await selectNode(page, "home.hero");
  await page.getByTestId("regen-button").click();
  const box = page.getByTestId("regen-instruction");
  await expect(box).toBeVisible();
  // pre-filled with the section's (canned) planner brief
  await expect(box).toHaveValue(/hero/i);
  // cost estimate shown before confirming
  await expect(page.getByTestId("regen-cost")).toContainText("30k");
  if (instruction !== undefined) {
    await box.fill(instruction);
  }
  await page.getByTestId("regen-confirm").click();
}

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

test("full regen round-trip: progress, surviving override re-applied, revert", async ({ page }) => {
  await styleOverrideHeadline(page);
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color))
    .toBe(ACCENT_RGB);

  await startRegen(page, "Make the headline about momentum.");

  // in-place progress over the section while the run is live
  await expect(page.getByTestId("regen-progress")).toBeVisible();
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  // new copy rendered...
  await expect(headline).toContainText("Regenerated:", { timeout: 15_000 });
  // ...and the surviving override visibly re-applied WITHOUT user action
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
    .toBe(ACCENT_RGB);

  // revert regeneration: original copy returns, override still applied
  await page.getByTestId("revert-regen-button").click();
  await expect(headline).not.toContainText("Regenerated:", { timeout: 15_000 });
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
    .toBe(ACCENT_RGB);
});

test("orphaned override dialog: lists exactly the lost edit, discard clears it", async ({ page }) => {
  // put an override on the node the regen will remove
  await selectNode(page, "home.hero.subheadline");
  await page.getByTestId("swatch-color-color.semantic.accent").click();
  await waitForSaved(page);

  await startRegen(page, "Please remove the subheadline entirely.");
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  const dialog = page.getByTestId("orphan-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("home.hero.subheadline");
  await expect(page.getByTestId("orphan-item")).toHaveCount(1);
  await expect(page.getByTestId("orphan-copy")).toBeVisible();

  await page.getByTestId("orphan-discard").click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  // the subheadline element is gone from the preview
  await expect(
    previewFrameLocator(page).locator('[data-node-id="home.hero.subheadline"]'),
  ).toHaveCount(0);
});

test("failed regen surfaces the report with a try-again affordance", async ({ page }) => {
  await startRegen(page, "FAIL this one please.");
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 30_000 });

  const failure = page.getByTestId("regen-failure");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Raw hex color");
  await page.getByTestId("regen-try-again").click();
  await expect(page.getByTestId("regen-instruction")).toBeVisible();
});

/* ---------- page-level regeneration (7.9, PRD section 4) ---------- */

test("page regen: every section regenerated, all overrides re-applied, one revert undoes the page", async ({
  page,
}) => {
  // Overrides on nodes in TWO different sections: the point of page scope is
  // that every section's surviving overrides re-apply, not just the one the
  // user happened to have selected.
  await styleOverrideHeadline(page);
  await selectNode(page, "home.faq.heading");
  await page.getByTestId("swatch-color-color.semantic.accent").click();
  await waitForSaved(page);

  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const faqHeading = previewFrameLocator(page).locator('[data-node-id="home.faq.heading"]');
  const color = (locator: typeof headline) =>
    locator.evaluate((el) => getComputedStyle(el).color);
  await expect.poll(() => color(faqHeading)).toBe(ACCENT_RGB);

  // Captured rather than assumed: earlier tests in this file regenerate the
  // same fixture project and do not restore it, so "back to the original copy"
  // is not a thing this test can assert. What revert has to guarantee is a
  // return to the state that existed immediately before THIS regeneration.
  const copyBeforeRegen = (await headline.textContent()) ?? "";

  await selectNode(page, "home.hero");
  await page.getByTestId("regen-page-button").click();
  // The cost estimate must scale with the page, because that is the whole
  // reason to show it before confirming — home has 6 sections.
  await expect(page.getByTestId("regen-cost")).toContainText("180k");
  await expect(page.getByTestId("regen-cost")).toContainText("6 sections");
  await page.getByTestId("regen-confirm").click();

  // Progress covers the page area, not one section's box (PRD 4.2).
  await expect(page.getByTestId("regen-progress")).toBeVisible();
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 120_000 });

  // The hero's copy changed (the mock's stand-in for new output), and BOTH
  // sections' overrides re-applied with no user action.
  await expect(headline).not.toHaveText(copyBeforeRegen, { timeout: 15_000 });
  await expect(headline).toContainText("Regenerated:", { timeout: 15_000 });
  await expect.poll(() => color(headline), { timeout: 10_000 }).toBe(ACCENT_RGB);
  await expect.poll(() => color(faqHeading), { timeout: 10_000 }).toBe(ACCENT_RGB);

  // ONE revert restores the whole route — the snapshot was always route-wide,
  // and the page path must take it once up front rather than per section (a
  // per-section snapshot would hold the previous section's new output, so this
  // assertion is what catches that).
  await page.getByTestId("revert-regen-button").click();
  await expect(headline).toHaveText(copyBeforeRegen, { timeout: 15_000 });
  await expect.poll(() => color(headline), { timeout: 10_000 }).toBe(ACCENT_RGB);
  await expect.poll(() => color(faqHeading), { timeout: 10_000 }).toBe(ACCENT_RGB);
});

/* ---------- add-a-section (7.6, PRD 4.1) ---------- */

test("add-a-section: pick an archetype, generate, and it lands at the clicked position", async ({
  page,
}) => {
  // This test's own budget, because the assertion below waits up to 60s and
  // the suite-wide budget is 30s (playwright.config.ts) — so that 60s was
  // never reachable. The visible symptom was a bare "Test timeout of 30000ms
  // exceeded" that names neither the step nor the expectation, which sends
  // you looking for a hang in the add-section flow rather than at the
  // arithmetic. The generous wait is deliberate (the mock delay is only
  // 1.5s, but this step also reloads the preview iframe and re-indexes the
  // shim); what was wrong was declaring it inside a budget a third its size.
  test.setTimeout(90_000);

  // An override on a NEIGHBOUR of the insertion point: adding a section must
  // not disturb the sections already on the page.
  await styleOverrideHeadline(page);
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color))
    .toBe(ACCENT_RGB);

  // "+" strips sit at every boundary; this one inserts directly after the hero
  await page.getByTestId("add-section-slot-home.hero").click({ force: true });
  await expect(page.getByTestId("add-section-panel")).toBeVisible();

  // the catalog comes from the orchestrator's own ARCHETYPE_CATALOG
  await expect(page.getByTestId("archetype-stats-band")).toBeVisible();
  // an archetype is required before anything can run
  await expect(page.getByTestId("add-section-confirm")).toBeDisabled();
  await page.getByTestId("archetype-stats-band").click();
  await page.getByTestId("add-section-instruction").fill("Three headline metrics with labels.");
  await expect(page.getByTestId("add-section-cost")).toContainText("30k");
  await page.getByTestId("add-section-confirm").click();

  await expect(page.getByTestId("add-section-running")).toBeVisible();
  await expect(page.getByTestId("add-section-running")).toBeHidden({ timeout: 60_000 });

  // it rendered, and it is a real selectable node rather than a stub
  const added = previewFrameLocator(page).locator('[data-node-id="home.stats-band"]');
  await expect(added).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".inspector-id")).toHaveText("home.stats-band");

  // It landed where the user clicked: appended in source, positioned by a
  // sectionOrder override (PRD 3.3), so it renders between hero and the next
  // section rather than at the bottom of the page.
  await expect
    .poll(async () => {
      const order = await previewFrameLocator(page)
        .locator("[data-node-id]")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => node.getAttribute("data-node-id"))
            .filter((id) => id !== null && id.split(".").length === 2),
        );
      return order.slice(0, 2);
    }, { timeout: 15_000 })
    .toEqual(["home.hero", "home.stats-band"]);

  // the neighbour's override is untouched
  await expect
    .poll(() => headline.evaluate((el) => getComputedStyle(el).color), { timeout: 10_000 })
    .toBe(ACCENT_RGB);

  // ...and it passes the gates. Export runs typecheck + all seven gates
  // (contract section 8), so a successful export is the assertion that the
  // added section is real code — and specifically that the sectionOrder
  // override placing it compiles, which is where 7.5 and 7.6 meet: the
  // exporter rejects an order that omits a section, so a newly added one that
  // never reached the manifest, or an order that never learned about it, both
  // fail loudly here rather than shipping a page missing a section.
  await waitForSaved(page);
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-success-title")).toBeVisible({ timeout: 120_000 });
});
