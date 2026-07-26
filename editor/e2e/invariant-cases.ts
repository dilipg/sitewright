/**
 * The invariant-suite case table (PRD 7.1). Milestone 5 extends coverage to
 * all channels and archetypes BY ADDING CASES HERE, not code: a case drives
 * real editor UI and names the node whose rendered box must match between
 * the edited preview and the built export, pixel for pixel.
 */
import type { Page } from "@playwright/test";
import { selectNode } from "./helpers";

export interface InvariantCase {
  name: string;
  /** Node whose rendered box is screenshot-compared (may differ from the edited node when the effect lands outside its border box, e.g. margins). */
  screenshotNode: string;
  apply: (page: Page) => Promise<void>;
}

export const INVARIANT_CASES: InvariantCase[] = [
  {
    name: "style: background token swatch on the section root",
    screenshotNode: "home.hero",
    apply: async (page) => {
      await selectNode(page, "home.hero");
      await page.getByTestId("swatch-background-color.semantic.accent").click();
    },
  },
  {
    name: "style: padding token stepper on the headline",
    screenshotNode: "home.hero.headline",
    apply: async (page) => {
      await selectNode(page, "home.hero.headline");
      await page.getByTestId("stepper-inc-padding").click();
    },
  },
  {
    name: "style: margin-top token stepper on the subheadline",
    screenshotNode: "home.hero",
    apply: async (page) => {
      await selectNode(page, "home.hero.subheadline");
      await page.getByTestId("stepper-inc-marginTop").click();
    },
  },
  {
    name: "style: off-scale custom background on the secondary CTA",
    screenshotNode: "home.hero.cta-secondary",
    apply: async (page) => {
      await selectNode(page, "home.hero.cta-secondary");
      await page.getByTestId("custom-toggle-background").click();
      await page.getByTestId("custom-input-background").fill("#ff5500");
      await page.getByTestId("custom-input-background").press("Enter");
    },
  },
];
