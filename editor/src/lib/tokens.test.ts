import { describe, expect, it } from "vitest";
import {
  isTokenRef,
  nearestSpaceStep,
  resolveTokenValue,
  scaleKeys,
  semanticColorOptions,
  tokenPathSet,
} from "./tokens";

const tokens = {
  color: {
    neutral: { "50": "#f8fafc", "900": "#0f172a" },
    primary: { "600": "#4f46e5" },
    semantic: {
      bg: "ref:color.neutral.50",
      text: "ref:color.neutral.900",
      accent: "ref:color.primary.600",
      accentContrast: "#ffffff",
    },
  },
  typography: {
    scale: { sm: "0.875rem", base: "1rem", lg: "1.125rem" },
    weight: { regular: 400, bold: 700 },
  },
  space: { "0": "0", "4": "1rem", "8": "2rem" },
};

describe("resolveTokenValue", () => {
  it("resolves direct values and ref chains", () => {
    expect(resolveTokenValue(tokens, "color.primary.600")).toBe("#4f46e5");
    expect(resolveTokenValue(tokens, "color.semantic.accent")).toBe("#4f46e5");
  });

  it("returns undefined for unknown paths", () => {
    expect(resolveTokenValue(tokens, "color.semantic.missing")).toBeUndefined();
  });
});

describe("semanticColorOptions", () => {
  it("lists semantic colors with resolved css values and labels", () => {
    const options = semanticColorOptions(tokens);
    expect(options.map((o) => o.path)).toEqual([
      "color.semantic.bg",
      "color.semantic.text",
      "color.semantic.accent",
      "color.semantic.accentContrast",
    ]);
    expect(options.find((o) => o.path === "color.semantic.accent")).toEqual({
      path: "color.semantic.accent",
      label: "Accent",
      css: "#4f46e5",
    });
  });
});

describe("scaleKeys", () => {
  it("returns ordered keys for a token group", () => {
    expect(scaleKeys(tokens, ["space"])).toEqual(["0", "4", "8"]);
    expect(scaleKeys(tokens, ["typography", "scale"])).toEqual(["sm", "base", "lg"]);
  });
});

describe("nearestSpaceStep", () => {
  // space: 0 -> 0px, 4 -> 1rem (16px), 8 -> 2rem (32px)
  it("snaps a raw pixel delta to the nearest space-scale magnitude, in px", () => {
    expect(nearestSpaceStep(tokens, 0)).toBe(0);
    expect(nearestSpaceStep(tokens, 20)).toBe(16); // closer to 16 than to 32
    expect(nearestSpaceStep(tokens, 30)).toBe(32); // closer to 32 than to 16
  });

  it("preserves the sign of the input", () => {
    expect(nearestSpaceStep(tokens, -20)).toBe(-16);
  });

  it("clamps to the largest available step when the delta exceeds every step", () => {
    expect(nearestSpaceStep(tokens, 1000)).toBe(32);
    expect(nearestSpaceStep(tokens, -1000)).toBe(-32);
  });
});

describe("isTokenRef", () => {
  it("accepts values that name an existing token path", () => {
    const paths = tokenPathSet(tokens);
    expect(isTokenRef("space.8", paths)).toBe(true);
    expect(isTokenRef("color.semantic.accent", paths)).toBe(true);
  });

  it("rejects free values and unknown paths", () => {
    const paths = tokenPathSet(tokens);
    expect(isTokenRef("#ff5500", paths)).toBe(false);
    expect(isTokenRef("13px", paths)).toBe(false);
    expect(isTokenRef("space.99", paths)).toBe(false);
  });
});
