/**
 * Plan-approval screen (PRD/pipeline 2.2): the plan gates generation spend.
 * Plan files are written into the served e2e project by the spec and
 * removed afterwards so the canvas specs stay unaffected.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const projectDir = fileURLToPath(new URL("../../generated/editor-e2e-project", import.meta.url));
const planDir = join(projectDir, "plan");

const SAMPLE_BRIEF = {
  siteType: "landing",
  brand: { name: "Acme Analytics", tone: "confident", audience: "small teams", oneLiner: "Product analytics in minutes." },
  creativity: "low",
  contentHints: [],
  pagesRequested: [],
  constraints: [],
  assumptions: ["Assumed a free trial exists."],
};

const SAMPLE_PLAN = {
  routes: [
    {
      slug: "home",
      path: "/",
      pageArchetype: "landing",
      title: "Home",
      sections: [
        { slug: "hero", archetype: "hero", brief: "Bold intro with trial CTA." },
        { slug: "features", archetype: "feature-grid", brief: "Key features." },
        { slug: "proof", archetype: "social-proof", brief: "Testimonials." },
        { slug: "cta", archetype: "cta-band", brief: "Final push." },
      ],
    },
    {
      slug: "pricing",
      path: "/pricing",
      pageArchetype: "marketing-page",
      title: "Pricing",
      sections: [
        { slug: "tiers", archetype: "pricing-tiers", brief: "Three tiers." },
        { slug: "faq", archetype: "faq-accordion", brief: "Billing questions." },
      ],
    },
  ],
};

test.beforeEach(() => {
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "brief.json"), JSON.stringify(SAMPLE_BRIEF, null, 2));
  writeFileSync(join(planDir, "siteplan.json"), JSON.stringify(SAMPLE_PLAN, null, 2));
  writeFileSync(join(planDir, "plan-status.json"), JSON.stringify({ approved: false }));
});

test.afterEach(() => {
  if (existsSync(planDir)) rmSync(planDir, { recursive: true, force: true });
});

test("unapproved plan shows the approval screen with routes and archetype labels", async ({ page }) => {
  await page.goto("/");
  const screen = page.getByTestId("plan-approval");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Acme Analytics");
  await expect(screen).toContainText("Assumed a free trial exists.");
  await expect(page.getByTestId("plan-route")).toHaveCount(2);
  await expect(screen).toContainText("/pricing");
  await expect(page.getByTestId("archetype-label").first()).toHaveText("hero");
  await expect(page.getByTestId("archetype-label")).toHaveCount(6);
});

test("section briefs are editable and persist to siteplan.json", async ({ page }) => {
  await page.goto("/");
  const heroBrief = page.getByTestId("section-brief-home-hero");
  await expect(heroBrief).toHaveValue("Bold intro with trial CTA.");
  await heroBrief.fill("Hero focused on the 5-minute setup story.");
  await heroBrief.blur();

  await expect
    .poll(() => {
      // resilient to torn reads: the server's writeFileSync is not atomic,
      // and a poll tick can land mid-write
      try {
        const plan = JSON.parse(readFileSync(join(planDir, "siteplan.json"), "utf8"));
        return plan.routes[0].sections[0].brief;
      } catch {
        return undefined;
      }
    })
    .toBe("Hero focused on the 5-minute setup story.");
});

test("approve dismisses the plan screen, reveals the canvas, and persists approval", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("plan-approve").click();

  await expect(page.getByTestId("plan-approval")).toHaveCount(0);
  await expect(
    page.frameLocator('iframe[title="preview-home"]').locator('[data-node-id="home.hero.headline"]'),
  ).toBeVisible();

  const status = JSON.parse(readFileSync(join(planDir, "plan-status.json"), "utf8"));
  expect(status.approved).toBe(true);
});
