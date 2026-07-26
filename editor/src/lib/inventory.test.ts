import { describe, expect, it } from "vitest";
import { PRIMITIVE_VARIANTS, expandStyleValue } from "./inventory";

describe("primitive variant inventory (M2 stub)", () => {
  it("knows the fixture primitives' variants", () => {
    expect(PRIMITIVE_VARIANTS["Button"]?.variants).toEqual(["primary", "secondary"]);
    expect(PRIMITIVE_VARIANTS["Text"]?.variants).toContain("eyebrow");
  });
});

describe("expandStyleValue", () => {
  it("expands a variant choice into its style declarations for the shim", () => {
    const expanded = expandStyleValue({ variant: "secondary" }, "Button");
    expect(expanded["background"]).toBe("color.semantic.surface");
    expect(expanded["color"]).toBe("color.semantic.text");
    expect(expanded["variant"]).toBeUndefined();
  });

  it("explicit properties win over variant declarations", () => {
    const expanded = expandStyleValue(
      { variant: "secondary", background: "color.semantic.danger" },
      "Button",
    );
    expect(expanded["background"]).toBe("color.semantic.danger");
  });

  it("passes values through untouched for elements without variants", () => {
    const expanded = expandStyleValue({ padding: "space.4" }, "section");
    expect(expanded).toEqual({ padding: "space.4" });
  });
});
