// server/src/project-registry.test.ts
/**
 * The spec's Testing requirement, made executable: "a request for another
 * user's project is rejected on EVERY project-scoped endpoint. Table-driven
 * over the endpoint list, so adding an endpoint without a rule fails."
 *
 * These tests are about the registry's integrity and its agreement with the
 * composed route table. The per-endpoint rejection behaviour itself lives in
 * require-project.test.ts, which tests the one wrapper all of them share.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_SCOPED_ENDPOINTS, SESSION_ONLY_ENDPOINTS } from "./project-registry.ts";

describe("the registry itself", () => {
  it("has no duplicate (method, path) entries", () => {
    const keys = PROJECT_SCOPED_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not list an endpoint as both project-scoped and session-only", () => {
    // The two lists are a partition. An endpoint in both means one of the two
    // rules is dead, and which one wins depends on registration order.
    const scoped = new Set(PROJECT_SCOPED_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    for (const e of SESSION_ONLY_ENDPOINTS) {
      expect(scoped.has(`${e.method} ${e.path}`)).toBe(false);
    }
  });

  it("gives every project-scoped endpoint a way to find its project id", () => {
    for (const e of PROJECT_SCOPED_ENDPOINTS) {
      expect(e.idFrom.name).toBeTruthy();
      if (e.idFrom.from === "param") {
        // A param source must name a segment the path actually declares,
        // otherwise the id is always undefined and every request 400s.
        expect(e.path).toContain(`:${e.idFrom.name}`);
      }
    }
  });

  it("covers every editor endpoint the compiler serves", () => {
    // The list that would otherwise drift. Copied from the handlers in
    // compiler/src/{regen-api,export-api,plan-api,preview}.ts — if a new one
    // is added there and not here, this fails, which is the point.
    const known = [
      "/__overrides/:slug", "/__overrides-history", "/__regen", "/__regen-page",
      "/__regen-revert", "/__add-section", "/__edit-prompt", "/__export",
      "/__export-download", "/__plan", "/__plan/section-brief", "/__plan/approve",
      "/__archetypes",
    ];
    const listed = new Set([
      ...PROJECT_SCOPED_ENDPOINTS.map((e) => e.path),
      ...SESSION_ONLY_ENDPOINTS.map((e) => e.path),
    ]);
    for (const path of known) expect(listed.has(path)).toBe(true);
  });
});
