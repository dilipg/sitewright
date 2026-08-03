import { describe, expect, it } from "vitest";
import { mockEditOperations } from "./edit-mock";

describe("mockEditOperations", () => {
  it("returns a style operation for a colour instruction", () => {
    const result = mockEditOperations("make the headline accent coloured", "home");
    expect(result.operations).toEqual([
      { op: "style", nodeId: "home.hero.headline", property: "color", token: "color.semantic.accent" },
    ]);
  });

  it("returns a clarify for an ambiguous instruction", () => {
    expect(mockEditOperations("make the button green", "home").clarify).toMatch(/which/i);
  });

  it("returns a structural verdict for an add request", () => {
    const result = mockEditOperations("add a testimonials section", "home");
    expect(result.structural?.kind).toBe("add-section");
    expect(result.operations).toEqual([]);
  });

  it("returns an invalid nodeId when asked to, so the editor's rejection path is testable", () => {
    // The e2e needs a way to exercise all-or-nothing rejection without a model.
    const result = mockEditOperations("INVALID", "home");
    expect(result.operations[0]!.nodeId).toBe("home.does-not-exist");
  });
});
