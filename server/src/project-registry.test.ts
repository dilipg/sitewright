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
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { buildRoutes } from "./compose.ts";
import { PreviewPool } from "./preview-pool.ts";
import { createProject } from "./projects.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { recordUsageEvent } from "./usage.ts";
import { createUser } from "./users.ts";
import {
  PROJECT_SCOPED_ENDPOINTS, SESSION_ONLY_ENDPOINTS, UNAUTHENTICATED_ENDPOINTS,
} from "./project-registry.ts";

// Shared by "registry vs. the live route table" and "billable endpoints"
// below: the ONE way this file builds a real, composed route table.
// Anything that wants to know what is actually reachable today must go
// through this, not through a hand-maintained list or a path-prefix
// predicate — see decisions.md (2026-08-06) for why that distinction was the
// entire point of the earlier "no billable route mounted" fix, and is
// exactly what lets this file's enforcement test (below) drive REAL requests
// rather than merely inspecting an array.
//
// A real PreviewPool is passed (never `undefined`): buildRoutes only mounts
// `/preview/:projectId/*` and the compiler's `/__*` endpoints when given one,
// so without this the routes this file just declared would be "declared but
// not mounted" against the live table below — not because they are
// unreachable in production, but because this helper stopped building the
// same table serve.ts does. Constructing a pool has no side effects on its
// own (nothing spawns until `acquire()` is called, which nothing here does).
const registryDirs: string[] = [];
const registryDbs: DatabaseSync[] = [];
function freshHarness() {
  const dir = mkdtempSync(join(tmpdir(), "server-registry-"));
  registryDirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  registryDbs.push(db);
  const masterKey = randomBytes(32);
  const pool = new PreviewPool({ db, masterKey, projectsRoot: dir });
  const routes = buildRoutes({ db, masterKey, secureCookies: true, pool });
  return { db, pool, routes, listener: createRequestListener(routes) };
}
afterAll(() => {
  for (const db of registryDbs) db.close();
  for (const dir of registryDirs) rmSync(dir, { recursive: true, force: true });
});

/** Drives one request through a harness's listener; mirrors the idiom every other route-table test file uses. */
async function call(
  listener: ReturnType<typeof createRequestListener>,
  method: string,
  path: string,
  cookie?: string,
): Promise<{ status: number; body: string }> {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; res.headersSent = true; return res; },
    setHeader() {},
    end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
  };
  const req = Object.assign((async function* () {})(), {
    method, url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
  });
  await listener(req as never, res as never);
  return { status, body: chunks.join("") };
}

/** Builds a request path for a registry entry: fills a `:name` router param if the id source is `param`, else appends `?<name>=<id>`. */
function pathFor(entry: { path: string; idFrom: { from: "param" | "query"; name: string } }, projectId: string): string {
  return entry.idFrom.from === "param"
    ? entry.path.replace(`:${entry.idFrom.name}`, projectId)
    : `${entry.path}?${entry.idFrom.name}=${encodeURIComponent(projectId)}`;
}

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
  it("places every buildRoutes entry in exactly one of the three lists", () => {
    // The direction that matters most: a route mounted in compose.ts that
    // nobody declared here would ship with whatever wrapper its author
    // reached for, unchecked by this table.
    const scoped = new Set(PROJECT_SCOPED_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    const sessionOnly = new Set(SESSION_ONLY_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    const unauthenticated = new Set(UNAUTHENTICATED_ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    for (const route of freshHarness().routes) {
      const key = `${route.method} ${route.path}`;
      const memberships =
        Number(scoped.has(key)) + Number(sessionOnly.has(key)) + Number(unauthenticated.has(key));
      expect(memberships, `${key} should be in exactly one list, was in ${memberships}`).toBe(1);
    }
  });

  it("has every declared entry from the three lists actually present in buildRoutes", () => {
    // The other direction: an entry declared here that is quietly wrong about
    // its own path or method — a typo, a stale rename — would otherwise never
    // be caught, since nothing before this compared the registry to the real
    // table at all. There used to be an exclusion here for the compiler's
    // `/__*` endpoints, correct while they were declared but not yet mounted
    // (see decisions.md, 2026-08-06) — now that compiler-routes.ts mounts
    // every one of them, EVERY declared entry must be live, with no carve-out.
    const live = new Set(freshHarness().routes.map((r) => `${r.method} ${r.path}`));
    const declared = [
      ...PROJECT_SCOPED_ENDPOINTS, ...SESSION_ONLY_ENDPOINTS, ...UNAUTHENTICATED_ENDPOINTS,
    ];
    for (const e of declared) {
      expect(live.has(`${e.method} ${e.path}`), `${e.method} ${e.path} is declared but not mounted`)
        .toBe(true);
    }
  });
});

describe("billable endpoints", () => {
  const all = [...PROJECT_SCOPED_ENDPOINTS, ...SESSION_ONLY_ENDPOINTS];

  it("is exactly the set that starts a model call", () => {
    const billable = all
      .filter((entry) => entry.billable)
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(billable).toEqual([
      "POST /__add-section",
      "POST /__edit-prompt",
      "POST /__regen",
      "POST /__regen-page",
    ]);
  });

  it("marks no identity endpoint billable", () => {
    for (const entry of all) {
      if (entry.path.startsWith("/api/")) expect(entry.billable).toBe(false);
    }
  });

  /**
   * Replaces the old placeholder ("has no billable endpoint mounted at all —
   * fails the moment 4c mounts one"), which could only ever observe
   * MOUNTEDNESS: a `Route` is `{method, path, handler}`, and nothing records
   * whether a handler is wrapped in `requireBudget`, so that test could not
   * tell a gated billable route from an ungated one — it was a tripwire
   * whose whole job was to fail once mounting became real, forcing this test
   * to be written. Table-driven over the registry's own billable entries
   * (not a separate hardcoded list), against the LIVE, composed route table,
   * so a future billable endpoint added without a `requireBudget` wrapper
   * fails this instead of shipping unguarded.
   */
  it.each(PROJECT_SCOPED_ENDPOINTS.filter((e) => e.billable))(
    "refuses $method $path with 402 over the cap, and never touches the pool",
    async (entry) => {
      const { db, pool, listener } = freshHarness();
      const owner = createUser(db, `${randomBytes(4).toString("hex")}@example.com`, "h");
      const project = createProject(db, owner.id, `run-${randomBytes(4).toString("hex")}`, "Over Cap");
      const cookie = `${SESSION_COOKIE}=${createSession(db, owner.id).id}`;
      // Default cap is $10; one event alone puts this user over it, the same
      // way require-budget.test.ts proves the wrapper in isolation.
      recordUsageEvent(db, {
        userId: owner.id, projectId: null, role: "section", model: "claude-sonnet-5",
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        costUsd: 11, at: Date.now(),
      });
      const acquireSpy = vi.spyOn(pool, "acquire");

      const result = await call(listener, entry.method, pathFor(entry, project.id), cookie);

      expect(result.status).toBe(402);
      const body = JSON.parse(result.body) as { capUsd: number; spentUsd: number; resetAt: number | null };
      expect(body.capUsd).toBe(10);
      expect(body.spentUsd).toBe(11);
      expect(typeof body.resetAt).toBe("number");
      // The authorization-before-capacity ordering matters here too: refusing
      // on the way past requireBudget must never have touched the pool
      // first — a spy, not merely the status code, is what proves that.
      expect(acquireSpy).not.toHaveBeenCalled();
    },
  );
});
