import { describe, expect, it } from "vitest";
import App from "./App";

describe("editor test runner", () => {
  it("runs (P0 placeholder)", () => {
    expect(typeof App).toBe("function");
  });
});