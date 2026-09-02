import { describe, expect, it } from "vitest";
import { COMPILER_PACKAGE } from "./index";

describe("compiler test runner", () => {
  it("runs (P0 placeholder)", () => {
    expect(COMPILER_PACKAGE).toBe("@sitewright/compiler");
  });
});