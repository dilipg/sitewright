/**
 * Failure-surface drill, editor half (pipeline section 8, build prompt 6.3).
 *
 * The rows whose handling is only observable in the running editor:
 *   row 4  section fails twice -> placeholder renders in preview, site continues
 *   row 7  regen removes an overridden element -> orphan dialog (regen.spec.ts)
 *   row 8  export build failure -> aborts loudly (export.spec.ts)
 *
 * Rows 7 and 8 have their own specs; this file covers row 4's preview
 * rendering, which nothing else exercised. The fixture's `about` route
 * carries a FailedSectionPlaceholder for exactly this purpose (see that
 * page's own comment) — it is the shape a page takes when one section
 * exhausts its bounded retries.
 */
import { expect, test } from "@playwright/test";
import { openEditor, routeFrameLocator, selectNode } from "./helpers";

test.use({ viewport: { width: 1700, height: 900 } });

const PLACEHOLDER_TEXT = "Section failed to generate";

test("a failed section renders as a visible placeholder, not a silent gap", async ({ page }) => {
  await openEditor(page);
  const about = routeFrameLocator(page, "about");

  const placeholder = about.getByText(PLACEHOLDER_TEXT);
  await expect(placeholder).toBeVisible();
  // it points the user at where the actual failure is recorded
  await expect(placeholder).toContainText("run log");
});

test("the rest of the page still renders around the failed section", async ({ page }) => {
  await openEditor(page);
  const about = routeFrameLocator(page, "about");

  // the sibling section is present and fully addressable — one section's
  // exhausted retries do not take the page (or the route) down with it
  await expect(about.locator('[data-node-id="about.intro"]')).toBeVisible();
  await selectNode(page, "about.intro");
  await expect(page.locator(".inspector-id")).toHaveText("about.intro");
});

test("the placeholder carries no node id, so the editor offers no edits for it", async ({ page }) => {
  await openEditor(page);
  const about = routeFrameLocator(page, "about");

  // No agent proposed a manifest entry for a section that never produced
  // structured output, so the placeholder must not claim an id either — a
  // stray one would fail gate 4 (node-ids-registered) at fan-out's
  // whole-project check.
  const placeholderSection = about.locator("section", { hasText: PLACEHOLDER_TEXT });
  await expect(placeholderSection).toHaveCount(1);
  await expect(placeholderSection).not.toHaveAttribute("data-node-id", /.+/);
});

test("other routes are unaffected by a route carrying a failed section", async ({ page }) => {
  await openEditor(page);
  // home is a different frame entirely; selection and editing still work
  await selectNode(page, "home.hero.headline");
  await expect(page.locator(".inspector-id")).toHaveText("home.hero.headline");
});
