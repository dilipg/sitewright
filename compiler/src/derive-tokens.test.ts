import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveTokens } from "./derive-tokens";

const fixtureTokensDir = fileURLToPath(
  new URL("../../fixtures/acme-landing/src/tokens/", import.meta.url),
);

/** Normalizes CRLF so tests survive git autocrlf checkouts. */
function readFixtureFile(name: string): string {
  return readFileSync(join(fixtureTokensDir, name), "utf8").replace(/\r\n/g, "\n");
}

function fixtureTokens(): unknown {
  return JSON.parse(readFixtureFile("tokens.json"));
}

describe("deriveTokens: fixture ground truth", () => {
  it("reproduces the fixture's tokens.css byte-for-byte", () => {
    const { tokensCss } = deriveTokens(fixtureTokens());
    expect(tokensCss).toBe(readFixtureFile("tokens.css"));
  });

  it("derives a stable tailwind theme mapping from the fixture", () => {
    const { tailwindTheme } = deriveTokens(fixtureTokens());
    expect(tailwindTheme).toMatchSnapshot();
  });

  it("is deterministic: same input object produces identical output", () => {
    const first = deriveTokens(fixtureTokens());
    const second = deriveTokens(fixtureTokens());
    expect(second.tokensCss).toBe(first.tokensCss);
    expect(second.tailwindTheme).toEqual(first.tailwindTheme);
  });
});

describe("deriveTokens: ref resolution", () => {
  it("resolves a ref: value to its target", () => {
    const { tokensCss } = deriveTokens({
      color: {
        neutral: { "50": "#f8fafc" },
        semantic: { bg: "ref:color.neutral.50" },
      },
    });
    expect(tokensCss).toContain("--color-semantic-bg: #f8fafc;");
  });

  it("resolves chained refs (ref pointing at a ref)", () => {
    const { tokensCss } = deriveTokens({
      color: {
        neutral: { "50": "#f8fafc" },
        semantic: { bg: "ref:color.neutral.50", surface: "ref:color.semantic.bg" },
      },
    });
    expect(tokensCss).toContain("--color-semantic-surface: #f8fafc;");
  });

  it("throws with the full cycle path on circular refs", () => {
    const circular = {
      color: {
        semantic: { a: "ref:color.semantic.b", b: "ref:color.semantic.a" },
      },
    };
    expect(() => deriveTokens(circular)).toThrow(
      "Circular token reference: color.semantic.a → color.semantic.b → color.semantic.a",
    );
  });

  it("throws naming the ref and its location on unknown refs", () => {
    const dangling = {
      color: {
        semantic: { accent: "ref:color.primary.600" },
      },
    };
    expect(() => deriveTokens(dangling)).toThrow(
      'Unknown token reference "ref:color.primary.600" at color.semantic.accent',
    );
  });
});

describe("deriveTokens: input validation", () => {
  it("throws on non-scalar token leaves", () => {
    expect(() => deriveTokens({ space: { "1": true } })).toThrow(
      "Invalid token value at space.1: expected string or number",
    );
  });
});

describe("deriveTokens: tailwind theme mapping", () => {
  it("maps token groups to var() references, keeping tokens.css the single source of truth", () => {
    const { tailwindTheme } = deriveTokens(fixtureTokens());
    expect(tailwindTheme.colors?.["semantic-accent"]).toBe("var(--color-semantic-accent)");
    expect(tailwindTheme.spacing?.["4"]).toBe("var(--space-4)");
    expect(tailwindTheme.fontSize?.["5xl"]).toBe("var(--typography-scale-5xl)");
    expect(tailwindTheme.fontFamily?.heading).toBe("var(--typography-fontFamily-heading)");
  });

  it("emits screens as literal values because media queries cannot read CSS vars", () => {
    const { tailwindTheme } = deriveTokens(fixtureTokens());
    expect(tailwindTheme.screens).toEqual({
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
    });
  });
});
