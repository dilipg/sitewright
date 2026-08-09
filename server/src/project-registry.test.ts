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
import { setApiKey } from "./api-keys.ts";
import { createProject } from "./projects.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { recordUsageEvent } from "./usage.ts";
import { createUser } from "./users.ts";
import {
  CONDITIONALLY_BILLABLE_ENDPOINTS, PROJECT_SCOPED_ENDPOINTS, SESSION_ONLY_ENDPOINTS, UNAUTHENTICATED_ENDPOINTS,
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
  // projectsRoot: reuses the SAME directory the pool itself resolves project
  // directories under — job-routes.ts's POST /api/generate creates a fresh
  // project's directory here, and without this argument buildRoutes leaves
  // job-routes unmounted entirely (mirrors `pool`'s own "declared but not
  // mounted" gate), which would make this the one route category the
  // billable-enforcement table below could never actually reach.
  const routes = buildRoutes({ db, masterKey, secureCookies: true, pool, projectsRoot: dir });
  return { db, masterKey, pool, routes, listener: createRequestListener(routes) };
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

type ProjectScopedEntry = (typeof PROJECT_SCOPED_ENDPOINTS)[number];
type SessionOnlyEntry = (typeof SESSION_ONLY_ENDPOINTS)[number];

describe("billable endpoints", () => {
  const all = [...PROJECT_SCOPED_ENDPOINTS, ...SESSION_ONLY_ENDPOINTS];

  it("is exactly the set that starts a model call", () => {
    const billable = all
      .filter((entry) => entry.billable)
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    // Slice 5 adds a fifth: POST /api/generate spawns the orchestrator
    // directly (the most expensive of all six job kinds) and is
    // session-only, since no project exists until this handler creates one.
    expect(billable).toEqual([
      "POST /__add-section",
      "POST /__edit-prompt",
      "POST /__regen",
      "POST /__regen-page",
      "POST /api/generate",
    ]);
  });

  it("marks no identity-management endpoint billable (login/key/project lookup) — POST /api/generate is the one deliberate /api/ exception", () => {
    // Before slice 5, EVERY /api/* endpoint was identity management (login,
    // key storage, project listing) and none of it started a model call, so
    // this test could assert the blanket rule directly. POST /api/generate
    // breaks that blanket rule on purpose (it is genuinely billable), so the
    // exclusion is now explicit and named rather than the rule silently
    // becoming false — a future SECOND billable /api/ endpoint still fails
    // this unless it, too, is added to the exception list by name.
    for (const entry of all) {
      if (entry.path.startsWith("/api/") && entry.path !== "/api/generate") {
        expect(entry.billable).toBe(false);
      }
    }
    expect(all.find((e) => e.path === "/api/generate")?.billable).toBe(true);
  });

  /**
   * Task-7-review finding 7: the house precedent set by the test above for
   * `/api/generate` (name a `billable: true` exception so a second cannot
   * silently join it) applies just as much in the OTHER direction — a
   * `billable: false` entry that still conditionally spends. Without this,
   * `POST /api/jobs/:id/resume` conditionally starting a model call is
   * documented only in prose, and a future SECOND such endpoint could be
   * added with `billable: false` and no cap check at all, invisibly, since
   * nothing here would notice.
   */
  it("names POST /api/jobs/:id/resume as the ONLY billable:false entry whose own handler can still conditionally start a model call", () => {
    expect(CONDITIONALLY_BILLABLE_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).toEqual([
      "POST /api/jobs/:id/resume",
    ]);
    // Consistency: every named entry must actually BE billable:false in the
    // real registry — if one were billable:true, it would already be
    // covered by the uniform it.each 402 test below and would not belong on
    // this separately-named list at all.
    for (const entry of CONDITIONALLY_BILLABLE_ENDPOINTS) {
      const match = all.find((e) => e.method === entry.method && e.path === entry.path);
      expect(match, `${entry.method} ${entry.path} must be a real registry entry`).toBeDefined();
      expect(match?.billable, `${entry.method} ${entry.path} must be billable:false to belong on this list`).toBe(false);
    }
  });

  /**
   * Replaces the old placeholder ("has no billable endpoint mounted at all —
   * fails the moment 4c mounts one"), which could only ever observe
   * MOUNTEDNESS: a `Route` is `{method, path, handler}`, and nothing records
   * whether a handler is wrapped in `requireBudget`, so that test could not
   * tell a gated billable route from an ungated one — it was a tripwire
   * whose whole job was to fail once mounting became real, forcing this test
   * to be written. Table-driven over BOTH billable lists (`all`, not just
   * `PROJECT_SCOPED_ENDPOINTS`) against the LIVE, composed route table, so a
   * future billable endpoint added to EITHER list without a `requireBudget`
   * wrapper fails this instead of shipping unguarded. `requireBudget`'s own
   * doc comment names two composition shapes it exists to serve —
   * `requireProject(db, source, requireBudget(db, handler))` and
   * `requireSession(db, requireBudget(db, handler))` — and a table that only
   * ever iterated the first would silently stop covering the second the
   * moment one existed. That is not hypothetical: slice 5's web-triggered
   * generation is a session-only billable endpoint, since no project id
   * exists yet when a generation starts.
   */
  it.each(all.filter((e) => e.billable))(
    "refuses $method $path with 402 over the cap, and never touches the pool",
    async (rawEntry) => {
      // it.each's own typings merge the table's element type for its
      // `$key`-interpolation feature, which erases `idFrom` to `unknown`
      // rather than preserving the PROJECT_SCOPED_ENDPOINTS |
      // SESSION_ONLY_ENDPOINTS union `all` actually has — recovered here so
      // the "in" check below narrows correctly.
      const entry = rawEntry as unknown as ProjectScopedEntry | SessionOnlyEntry;
      const { db, masterKey, pool, listener } = freshHarness();
      const owner = createUser(db, `${randomBytes(4).toString("hex")}@example.com`, "h");
      const cookie = `${SESSION_COOKIE}=${createSession(db, owner.id).id}`;
      // A stored key, so task 4's requireApiKey (which now runs BEFORE
      // requireBudget on every billable entry — see compiler-routes.ts) does
      // not intercept this request with 400 first: this test is specifically
      // about the CAP, and a keyless owner would never reach it.
      setApiKey(db, masterKey, owner.id, "sk-ant-test-key-for-cap-test");
      // Default cap is $10; one event alone puts this user over it, the same
      // way require-budget.test.ts proves the wrapper in isolation.
      recordUsageEvent(db, {
        userId: owner.id, projectId: null, role: "section", model: "claude-sonnet-5",
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        costUsd: 11, at: Date.now(),
      });
      const acquireSpy = vi.spyOn(pool, "acquire");

      // A project-scoped entry needs a real project to name; a session-only
      // one (the "in" check is false for every SESSION_ONLY_ENDPOINTS entry,
      // since that list's type carries no `idFrom` field at all — see
      // project-registry.ts) has no project id to supply in the first
      // place, so the bare path is the whole request.
      const path = "idFrom" in entry
        ? pathFor(entry, createProject(db, owner.id, `run-${randomBytes(4).toString("hex")}`, "Over Cap").id)
        : entry.path;

      const result = await call(listener, entry.method, path, cookie);

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

  /**
   * Was a `it.skipIf(...)` placeholder: "no session-only billable endpoint
   * exists today, so the `idFrom` absent branch above never actually runs."
   * `POST /api/generate` (slice 5) is exactly the endpoint that skip was left
   * for — it is session-only (no project exists until the handler creates
   * one) and `billable: true`, so it now flows through the it.each table
   * above for real. This is the replacement: a positive assertion that the
   * table's "idFrom absent" branch is genuinely exercised, not a vacuous
   * pass — if a future change ever left SESSION_ONLY_ENDPOINTS with no
   * billable entry again, THIS fails loudly instead of the coverage gap
   * silently reopening unnoticed.
   */
  it("the it.each table above also exercises a session-only billable endpoint, not only project-scoped ones", () => {
    const sessionOnlyBillable = SESSION_ONLY_ENDPOINTS.filter((e) => e.billable);
    expect(sessionOnlyBillable.map((e) => `${e.method} ${e.path}`)).toEqual(["POST /api/generate"]);
  });

  /**
   * FIX for the enumeration-oracle ordering: the composition is
   * `requireProject(db, idFrom, requireBudget(db, forward))`, so a foreign
   * project must 404 BEFORE the cap is ever consulted. The existing 404 test
   * (`registry vs. the live route table` above, and preview/compiler-routes'
   * own suites) all use a requester who is UNDER the cap, so none of them
   * would notice the order reversed — a 402 would satisfy "not 200" just as
   * well as a 404 does. This drives an OVER-cap requester at ANOTHER user's
   * project specifically, so that reversing the order (checking budget
   * first) would answer 402 instead of 404 — which would leak which project
   * ids exist to anyone willing to spend past their own cap first.
   */
  it.each(PROJECT_SCOPED_ENDPOINTS.filter((e) => e.billable))(
    "404s another user's project on $method $path even when the requester is over the cap — never 402",
    async (entry) => {
      const { db, pool, listener } = freshHarness();
      const owner = createUser(db, `${randomBytes(4).toString("hex")}@example.com`, "h");
      const requester = createUser(db, `${randomBytes(4).toString("hex")}@example.com`, "h");
      const project = createProject(db, owner.id, `run-${randomBytes(4).toString("hex")}`, "Owner's");
      const cookie = `${SESSION_COOKIE}=${createSession(db, requester.id).id}`;
      recordUsageEvent(db, {
        userId: requester.id, projectId: null, role: "section", model: "claude-sonnet-5",
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        costUsd: 11, at: Date.now(),
      });
      const acquireSpy = vi.spyOn(pool, "acquire");

      const result = await call(listener, entry.method, pathFor(entry, project.id), cookie);

      expect(result.status).toBe(404);
      expect(acquireSpy).not.toHaveBeenCalled();
    },
  );
});
