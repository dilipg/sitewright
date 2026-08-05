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
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { buildRoutes } from "./compose.ts";
import {
  isUnmountedCompilerEndpoint, PROJECT_SCOPED_ENDPOINTS, SESSION_ONLY_ENDPOINTS,
  UNAUTHENTICATED_ENDPOINTS,
} from "./project-registry.ts";

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

  it("does not list any (method, path) in more than one of the three lists", () => {
    // Three-way version of the partition check above, now that a third list
    // (UNAUTHENTICATED_ENDPOINTS) exists. An entry in two lists means two
    // different authorization rules could apply to the same request.
    const all = [
      ...PROJECT_SCOPED_ENDPOINTS.map((e) => `${e.method} ${e.path}`),
      ...SESSION_ONLY_ENDPOINTS.map((e) => `${e.method} ${e.path}`),
      ...UNAUTHENTICATED_ENDPOINTS.map((e) => `${e.method} ${e.path}`),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

/**
 * The bidirectional check the comment on the old "covers every editor
 * endpoint" test claimed to be, but wasn't: that test compared the registry
 * against a second hardcoded literal list inside this same file, so adding an
 * endpoint to compose.ts and to that literal (but forgetting the right
 * authorization wrapper) still passed every test. This compares the registry
 * against buildRoutes — the actual, live, composed route table — instead.
 */
describe("registry vs. the live route table", () => {
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];
  function freshRoutes() {
    const dir = mkdtempSync(join(tmpdir(), "server-registry-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "identity.db"));
    dbs.push(db);
    return buildRoutes({ db, masterKey: randomBytes(32), secureCookies: true });
  }
  afterAll(() => {
    for (const db of dbs) db.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("places every buildRoutes entry in exactly one of the three lists", () => {
    // The direction that matters most: a route mounted in compose.ts that
    // nobody declared here would ship with whatever wrapper its author
    // reached for, unchecked by this table.
    const scoped = new Set(PROJECT_SCOPED_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    const sessionOnly = new Set(SESSION_ONLY_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    const unauthenticated = new Set(UNAUTHENTICATED_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    for (const route of freshRoutes()) {
      const key = `${route.method} ${route.path}`;
      const memberships =
        Number(scoped.has(key)) + Number(sessionOnly.has(key)) + Number(unauthenticated.has(key));
      expect(memberships, `${key} should be in exactly one list, was in ${memberships}`).toBe(1);
    }
  });

  it("has every mountable-today entry from the three lists actually present in buildRoutes", () => {
    // The other direction: an entry declared here that is quietly wrong about
    // its own path or method — a typo, a stale rename — would otherwise never
    // be caught, since nothing before this compared the registry to the real
    // table at all.
    const live = new Set(freshRoutes().map((r) => `${r.method} ${r.path}`));
    const declared = [
      ...PROJECT_SCOPED_ENDPOINTS, ...SESSION_ONLY_ENDPOINTS, ...UNAUTHENTICATED_ENDPOINTS,
    ];
    for (const e of declared) {
      if (isUnmountedCompilerEndpoint(e.path)) continue; // asserted separately below
      expect(live.has(`${e.method} ${e.path}`), `${e.method} ${e.path} is declared but not mounted`)
        .toBe(true);
    }
  });

  it("excludes exactly the compiler endpoints not yet mounted, pending 4c's preview pool", () => {
    // Pins the exclusion so it cannot quietly grow: if a future entry's path
    // happens to start with "/__" but IS mounted (or vice versa), this fails
    // rather than the direction-2 test above silently skipping it forever.
    const excluded = [
      ...PROJECT_SCOPED_ENDPOINTS, ...SESSION_ONLY_ENDPOINTS, ...UNAUTHENTICATED_ENDPOINTS,
    ]
      .filter((e) => isUnmountedCompilerEndpoint(e.path))
      .map((e) => `${e.method} ${e.path}`)
      .sort();
    expect(excluded).toEqual([
      "GET /__archetypes",
      "GET /__export-download",
      "GET /__overrides-history",
      "GET /__overrides/:slug",
      "GET /__plan",
      "POST /__add-section",
      "POST /__edit-prompt",
      "POST /__export",
      "POST /__plan/approve",
      "POST /__plan/section-brief",
      "POST /__regen",
      "POST /__regen-page",
      "POST /__regen-revert",
      "PUT /__overrides-history",
      "PUT /__overrides/:slug",
    ].sort());
  });
});
