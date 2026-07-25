import { describe, expect, it } from "vitest";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import { breadcrumbFor, humanizeSegment, parentNodeId } from "./labels";

const manifest: Manifest = {
  version: 1,
  nodes: {
    "home.hero": {
      route: "/",
      file: "src/pages/home/sections/Hero.tsx",
      component: "Hero",
      element: "section",
      editable: ["style"],
      status: "active",
    },
    "home.hero.headline": {
      route: "/",
      file: "src/pages/home/sections/Hero.tsx",
      component: "Hero",
      element: "Heading",
      editable: ["text", "style"],
      status: "active",
    },
    "home.tiers.tier-1.cta": {
      route: "/",
      file: "src/pages/home/sections/Tiers.tsx",
      component: "Tiers",
      element: "Button",
      editable: ["text"],
      status: "active",
    },
  },
};

describe("humanizeSegment", () => {
  it("title-cases hyphenated slugs", () => {
    expect(humanizeSegment("headline")).toBe("Headline");
    expect(humanizeSegment("primary-action")).toBe("Primary Action");
  });

  it("uppercases known acronyms", () => {
    expect(humanizeSegment("cta-primary")).toBe("CTA Primary");
    expect(humanizeSegment("faq")).toBe("FAQ");
  });
});

describe("parentNodeId", () => {
  it("walks one level up to an existing manifest node", () => {
    expect(parentNodeId("home.hero.headline", manifest)).toBe("home.hero");
  });

  it("skips ancestry levels that have no manifest node", () => {
    // home.tiers.tier-1 and home.tiers are not registered — no parent to select
    expect(parentNodeId("home.tiers.tier-1.cta", manifest)).toBeUndefined();
  });

  it("returns undefined above section level (page scope)", () => {
    expect(parentNodeId("home.hero", manifest)).toBeUndefined();
  });
});

describe("breadcrumbFor", () => {
  it("renders page › section › element for an element node", () => {
    expect(breadcrumbFor("home.hero.headline", manifest)).toEqual([
      { label: "Home", nodeId: undefined },
      { label: "Hero", nodeId: "home.hero" },
      { label: "Headline", nodeId: "home.hero.headline" },
    ]);
  });

  it("renders page › section for a section root", () => {
    expect(breadcrumbFor("home.hero", manifest)).toEqual([
      { label: "Home", nodeId: undefined },
      { label: "Hero", nodeId: "home.hero" },
    ]);
  });

  it("renders just the page when nothing is selected", () => {
    expect(breadcrumbFor(undefined, manifest)).toEqual([{ label: "Home", nodeId: undefined }]);
  });

  it("collapses deep element paths into one crumb per remaining segment", () => {
    expect(breadcrumbFor("home.tiers.tier-1.cta", manifest)).toEqual([
      { label: "Home", nodeId: undefined },
      { label: "Tiers", nodeId: "home.tiers" },
      { label: "Tier 1", nodeId: "home.tiers.tier-1" },
      { label: "CTA", nodeId: "home.tiers.tier-1.cta" },
    ]);
  });
});
