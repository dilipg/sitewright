import { describe, expect, it } from "vitest";
import { mockEditOperations } from "./edit-mock";

describe("mockEditOperations", () => {
  it("returns a style operation for a colour instruction", () => {
    const result = mockEditOperations("make the headline accent coloured", "home");
    expect(result.operations).toEqual([
      { op: "style", nodeId: "home.hero.headline", property: "color", token: "color.semantic.accent" },
    ]);
  });

  it("returns a style operation on the cta-band heading for the accent-colour-change instruction, not the hero headline the general colour branch targets", () => {
    // accentContrast, not accent: the cta-band section's own background is
    // already the accent token elsewhere in the invariant suite, so recolouring
    // this heading's TEXT to the same token would make it blend into its own
    // background instead of demonstrating the override visually.
    const result = mockEditOperations("make the accent colour change", "home");
    expect(result.operations).toEqual([
      { op: "style", nodeId: "home.cta-band.heading", property: "color", token: "color.semantic.accentContrast" },
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

  it("returns two operations on two distinct nodes for a compound instruction", () => {
    // Every other branch returns at most one operation, which can't tell
    // "pushHistory once per prompt" apart from "once per operation" — this
    // is the branch the editor's compound-instruction undo test relies on.
    const result = mockEditOperations("update the eyebrow and the subhead", "home");
    expect(result.operations).toEqual([
      { op: "text", nodeId: "home.hero.eyebrow", value: "New eyebrow copy" },
      { op: "text", nodeId: "home.hero.subheadline", value: "New subheadline copy" },
    ]);
  });

  it("returns no operations for an instruction that matches nothing", () => {
    const result = mockEditOperations("do something the mock has never heard of", "home");
    expect(result.operations).toEqual([]);
    expect(result.clarify).toBeUndefined();
    expect(result.structural).toBeUndefined();
  });
});
