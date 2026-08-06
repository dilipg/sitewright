// server/src/compiler-routes.test.ts
/**
 * Drives the real, composed route table
 * (createRequestListener(compilerRoutes(...))) against a FAKE pool and a
 * mocked preview-proxy — the same idiom preview-routes.test.ts uses, since
 * the underlying shape (ownership check, then acquire/retain/proxy/release)
 * is identical; only the project-id source (every compiler entry is
 * `BY_QUERY`, never a route `:param`) and the spend-cap wrapper on billable
 * entries differ.
 *
 * DELIBERATE GAP, reported rather than papered over: the brief's item 8 ("a
 * client-supplied x-webgen-usage-id header does not reach the upstream")
 * cannot be proven through THIS harness. proxyHttp is stubbed here, so the
 * real deletion code (preview-proxy.ts's `upstreamHeaders`) never runs —
 * compiler-routes.ts always forwards `req` (headers untouched) straight into
 * `proxyHttp`, by design (stripping is proxyHttp's job, not this module's),
 * so a correct implementation and a buggy one would produce an IDENTICAL
 * recorded call here. A test built on this mock could assert the header is
 * present in the mock's `args.req.headers` and it would pass regardless of
 * whether the real code strips it — which is exactly the "can never fail no
 * matter what" shape this codebase's own decisions.md repeatedly flags. The
 * actual, perturbation-provable test for that property lives in
 * preview-proxy.test.ts, sibling to the pre-existing cookie/authorization
 * case, where the real (unmocked) upstreamHeaders/proxyHttp genuinely runs.
 * See the task report for Step 5's proof against that test.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createProject, type Project } from "./projects.ts";
import { recordUsageEvent, spendSince } from "./usage.ts";
import { createRequestListener } from "./router.ts";
import {
  MAX_BILLABLE_IN_FLIGHT_PER_USER,
  MAX_PREVIEWS,
  PreviewCapacityError,
  type PreviewPool,
} from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { compilerRoutes } from "./compiler-routes.ts";
import { DisabledUserError, MissingApiKeyError, UnknownUserError } from "./agent-env.ts";
import { UndecryptableApiKeyError } from "./api-keys.ts";
import { USAGE_ID_HEADER, isValidUsageId, usageLogPathFor } from "../../compiler/src/usage-log-path.ts";

const proxyMocks = vi.hoisted(() => ({
  // Return type matches the REAL proxyHttp's contract (FIX 3): `{ completed
  // }`, not bare `void` — preview-forward.ts reads `.completed` off
  // whatever this resolves to, so a test that wants the ingest gate to run
  // (the common case) must resolve `{ completed: true }`, exactly like a
  // real, fully-relayed exchange would.
  impl: async (args: {
    res: { writeHead: (code: number) => unknown; end: (chunk?: string) => unknown };
    setHeaders?: Record<string, string>;
  }): Promise<{ completed: boolean }> => {
    args.res.writeHead(200);
    args.res.end("proxied");
    return { completed: true };
  },
  calls: [] as Array<{ port: number; path: string; setHeaders?: Record<string, string> | undefined }>,
}));

// Vitest hoists vi.mock calls above every import in this file, so
// compiler-routes.ts's own `import { proxyHttp } from "./preview-proxy.ts"`
// resolves to this mock — same idiom preview-routes.test.ts uses.
vi.mock("./preview-proxy.ts", () => ({
  proxyHttp: (args: {
    req: unknown;
    res: unknown;
    port: number;
    path: string;
    setHeaders?: Record<string, string> | undefined;
  }) => {
    proxyMocks.calls.push({ port: args.port, path: args.path, setHeaders: args.setHeaders });
    return proxyMocks.impl(args as never);
  },
}));

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface FakePool {
  acquire: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  assertApiKeyUsable: ReturnType<typeof vi.fn>;
  // Explicitly typed (not the bare `ReturnType<typeof vi.fn>` the other
  // fields use): those are only ever asserted ON, never called BY test code,
  // so the untyped default (which TS widens to the constraint `Procedure |
  // Constructable`, and a union of those two is not directly callable) never
  // mattered until these two — the concurrency tests below call them
  // directly to seed/drain reservations.
  reserveBillableSlot: ReturnType<typeof vi.fn<(userId: string) => boolean>>;
  releaseBillableSlot: ReturnType<typeof vi.fn<(userId: string) => void>>;
}

function fakePool(acquireImpl?: (project: Project, ownerId: string) => Promise<{ port: number; base: string }>): FakePool {
  // A real (small, in-memory) per-user counter, not just a spy that always
  // succeeds — the concurrency tests below need genuine reserve/refuse/
  // release behaviour to prove compiler-routes.ts actually WIRES the
  // wrapper around the forward call correctly. PreviewPool's OWN counting
  // logic is separately, directly unit-tested in preview-pool.test.ts; this
  // is deliberately an independent implementation of the same small rule; a
  // shared bug in both would still be caught by preview-pool.test.ts.
  const billableInFlight = new Map<string, number>();
  return {
    acquire: vi.fn(acquireImpl ?? (async () => ({ port: 6001, base: "/preview/x/" }))),
    retain: vi.fn(),
    release: vi.fn(),
    assertApiKeyUsable: vi.fn(),
    reserveBillableSlot: vi.fn<(userId: string) => boolean>((userId) => {
      const current = billableInFlight.get(userId) ?? 0;
      if (current >= MAX_BILLABLE_IN_FLIGHT_PER_USER) return false;
      billableInFlight.set(userId, current + 1);
      return true;
    }),
    releaseBillableSlot: vi.fn<(userId: string) => void>((userId) => {
      const current = billableInFlight.get(userId) ?? 0;
      billableInFlight.set(userId, Math.max(0, current - 1));
    }),
  };
}

/** Every /__* entry in the registry — what compilerRoutes is supposed to derive its output from. */
const COMPILER_ENTRIES = PROJECT_SCOPED_ENDPOINTS.filter((e) => e.path.startsWith("/__"));
const BILLABLE_ENTRIES = COMPILER_ENTRIES.filter((e) => e.billable);

type CompilerEntry = (typeof PROJECT_SCOPED_ENDPOINTS)[number];

/**
 * Builds a request path for one registry entry: the route's own `:name`
 * segment (if any — e.g. `/__overrides/:slug`'s `:slug`, which names an
 * override FILE, not a project) filled with an arbitrary literal, and the
 * project id appended as `?project=<id>` when `idFrom` is BY_QUERY (true for
 * every compiler entry today). Generic over a future `param`-sourced entry
 * too, since router.ts allows at most one `:name` segment per route.
 */
function pathFor(entry: CompilerEntry, projectId: string): string {
  const withParam = entry.path.replace(/:([A-Za-z0-9_]+)/, (_match, name: string) =>
    entry.idFrom.from === "param" && entry.idFrom.name === name ? projectId : "placeholder-value");
  if (entry.idFrom.from === "query") {
    return `${withParam}${withParam.includes("?") ? "&" : "?"}${entry.idFrom.name}=${encodeURIComponent(projectId)}`;
  }
  return withParam;
}

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "server-compilerroutes-db-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  return db;
}

function harness(pool: FakePool) {
  const dir = mkdtempSync(join(tmpdir(), "server-compilerroutes-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const project = createProject(db, alice.id, "alice-run", "Alice");
  const listener = createRequestListener(compilerRoutes({ db, pool: pool as unknown as PreviewPool }));

  async function call(method: string, path: string, cookie?: string) {
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

  return {
    db, alice, bob, project, call,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
  };
}

beforeEach(() => {
  proxyMocks.calls = [];
  proxyMocks.impl = async (args) => {
    args.res.writeHead(200);
    args.res.end("proxied");
    return { completed: true };
  };
});

describe("compilerRoutes", () => {
  it("mounts exactly the registry's /__* entries — bidirectional", () => {
    // Neither direction can drift silently: an entry missing from the
    // output would leave that endpoint unreachable (deny-by-default is
    // "safe" but wrong), and an extra route not backed by a registry entry
    // would be unguarded by project-registry.test.ts's partition check.
    const pool = fakePool();
    const routes = compilerRoutes({ db: freshDb(), pool: pool as unknown as PreviewPool });
    const routeKeys = routes.map((r) => `${r.method} ${r.path}`).sort();
    const registryKeys = COMPILER_ENTRIES.map((e) => `${e.method} ${e.path}`).sort();
    expect(routeKeys).toEqual(registryKeys);
  });

  it.each(COMPILER_ENTRIES)("401s an unauthenticated request to $method $path and never touches the pool", async (entry) => {
    const pool = fakePool();
    const { call, project } = harness(pool);
    const result = await call(entry.method, pathFor(entry, project.id));
    expect(result.status).toBe(401);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it.each(COMPILER_ENTRIES)("404s another user's project on $method $path and never touches the pool", async (entry) => {
    const pool = fakePool();
    const { call, project, bobCookie } = harness(pool);
    const result = await call(entry.method, pathFor(entry, project.id), bobCookie);
    expect(result.status).toBe(404);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it.each(COMPILER_ENTRIES)("proxies $method $path for the owner, forwarding req.url verbatim including the query string", async (entry) => {
    const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
    const { call, project, alice, aliceCookie } = harness(pool);
    const base = pathFor(entry, project.id);
    // Extra query params beyond the project id, appended the same way Vite's
    // own HMR client appends `?token=...`: a version that rebuilt the path
    // instead of forwarding req.url verbatim would drop these.
    const requestPath = `${base}${base.includes("?") ? "&" : "?"}extra=1&token=abc`;
    const result = await call(entry.method, requestPath, aliceCookie);
    expect(result.status).toBe(200);
    // A billable entry also carries a setHeaders (task 3's usage id) that
    // this test isn't about — asserted separately in the "attributing
    // billable spend" block below — so it's allowed here, not required.
    expect(proxyMocks.calls).toEqual([
      { port: 7777, path: requestPath, setHeaders: entry.billable ? expect.any(Object) : undefined },
    ]);
    expect(pool.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), alice.id);
  });

  it.each(BILLABLE_ENTRIES)(
    "refuses $method $path with 402 over the cap, carrying capUsd/spentUsd/resetAt, and never touches the pool",
    async (entry) => {
      const pool = fakePool();
      const { db, call, project, alice, aliceCookie } = harness(pool);
      recordUsageEvent(db, {
        userId: alice.id, projectId: null, role: "section", model: "claude-sonnet-5",
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        costUsd: 11, at: Date.now(),
      });
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(402);
      const body = JSON.parse(result.body) as { capUsd: number; spentUsd: number; resetAt: number | null };
      expect(body.capUsd).toBe(10);
      expect(body.spentUsd).toBe(11);
      expect(typeof body.resetAt).toBe("number");
      expect(pool.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(COMPILER_ENTRIES.filter((e) => e.path === "/__export" || e.path === "/__export-download"))(
    "does not gate $method $path on the spend cap — a user over the cap still reaches the proxy",
    async (entry) => {
      const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
      const { db, call, project, alice, aliceCookie } = harness(pool);
      recordUsageEvent(db, {
        userId: alice.id, projectId: null, role: "section", model: "claude-sonnet-5",
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        costUsd: 999, at: Date.now(),
      });
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      // Exporting spends nothing, so refusing it over the cap would strand a
      // user's finished work behind a bill (spec, binding constraint).
      expect(result.status).toBe(200);
      expect(pool.acquire).toHaveBeenCalled();
    },
  );

  it.each([
    COMPILER_ENTRIES.find((e) => e.path === "/__regen")!,
    COMPILER_ENTRIES.find((e) => e.path === "/__export")!,
  ])("releases the preview even when the proxy call rejects ($method $path)", async (entry) => {
    proxyMocks.impl = async () => { throw new Error("proxy exploded"); };
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    // The router's own top-level catch turns the re-thrown error into a 500
    // — the property under test is that release() still ran despite it.
    expect(result.status).toBe(500);
    expect(pool.retain).toHaveBeenCalledWith(project.id);
    expect(pool.release).toHaveBeenCalledWith(project.id);
  });

  it("maps PreviewCapacityError to 503 naming the cap, exactly as preview-routes.ts does", async () => {
    const pool = fakePool(async () => { throw new PreviewCapacityError(); });
    const { call, project, aliceCookie } = harness(pool);
    const entry = COMPILER_ENTRIES.find((e) => e.path === "/__plan")!;
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    expect(result.status).toBe(503);
    expect(result.body).toContain(String(MAX_PREVIEWS));
    expect(proxyMocks.calls).toEqual([]);
  });
});

/**
 * Task 3: attributing a billable request's model spend to the user who paid.
 * The mocked `proxyHttp` from the top of this file stands in for the child:
 * these tests script its `impl` to read `args.setHeaders[USAGE_ID_HEADER]`
 * (the id `compiler-routes.ts` generated for THIS request) and write a fake
 * usage log at exactly the path `usageLogPathFor` derives from it — the same
 * path `compiler-routes.ts` itself ingests from afterwards — so the test
 * proves the real id round-trips through the real path derivation, not a
 * hardcoded stand-in.
 */
function usageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    role: "section",
    model: "claude-sonnet-5",
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 1,
    ...overrides,
  };
}

/** Writes a fake child usage log at the path the given usage id implies, creating the temp directory `usageLogPathFor` expects. */
function writeUsageLog(usageId: string, rows: Array<Record<string, unknown>>): string {
  const path = usageLogPathFor(usageId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  return path;
}

describe("compilerRoutes: attributing billable spend", () => {
  const billableEntry = BILLABLE_ENTRIES[0]!;

  it("sets a well-formed x-webgen-usage-id on a billable request, a different one per request", async () => {
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
    await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);

    expect(proxyMocks.calls).toHaveLength(2);
    const id1 = proxyMocks.calls[0]?.setHeaders?.[USAGE_ID_HEADER];
    const id2 = proxyMocks.calls[1]?.setHeaders?.[USAGE_ID_HEADER];
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    // Pinned against the real predicate, not a copy of its regex: this fails
    // if compiler-routes.ts ever generates the id a different way (e.g. a
    // different byte length, or uppercase hex) even if that value still
    // "looks like" an id to the eye.
    expect(isValidUsageId(id1)).toBe(true);
    expect(isValidUsageId(id2)).toBe(true);
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
    // A different one per request — this is the assertion Step 4's third
    // perturbation (making the id a constant) is proved against.
    expect(id1).not.toBe(id2);
  });

  it("sends no usage id header on a non-billable request", async () => {
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    const entry = COMPILER_ENTRIES.find((e) => !e.billable)!;
    await call(entry.method, pathFor(entry, project.id), aliceCookie);

    expect(proxyMocks.calls).toHaveLength(1);
    expect(proxyMocks.calls[0]?.setHeaders).toBeUndefined();
  });

  it("ingests the child's usage log into usage_event, attributed to the owner, and deletes the file afterwards", async () => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    let capturedPath = "";
    proxyMocks.impl = async (args) => {
      const usageId = args.setHeaders?.[USAGE_ID_HEADER];
      if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
      capturedPath = writeUsageLog(usageId, [usageRow({ cost_usd: 1 }), usageRow({ cost_usd: 2 })]);
      args.res.writeHead(200);
      args.res.end("proxied");
      return { completed: true };
    };

    const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
    expect(result.status).toBe(200);

    // usage_event holds the rows, attributed to alice — and exactly the two
    // rows the child wrote, not double: this is Step 1's item 7, "ingest
    // happens exactly once."
    const window = spendSince(db, alice.id, 0);
    expect(window.events).toBe(2);
    expect(window.costUsd).toBe(3);

    // The log file is gone afterwards.
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("ingests nothing and does not throw when the child wrote no usage log", async () => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    // beforeEach's default impl never writes a log file for any id.
    const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
    expect(result.status).toBe(200);
    expect(spendSince(db, alice.id, 0)).toEqual({ costUsd: 0, events: 0, unpricedEvents: 0 });
  });

  it("still ingests the usage log when the proxy call rejects — spend survives failure", async () => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    proxyMocks.impl = async (args) => {
      const usageId = args.setHeaders?.[USAGE_ID_HEADER];
      if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
      writeUsageLog(usageId, [usageRow({ cost_usd: 5 })]);
      throw new Error("proxy exploded partway through a real run");
    };

    const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
    // The router's own top-level catch turns the re-thrown error into a 500
    // — the property under test is that the spend was still recorded despite
    // the failed request, because ingest runs in the same finally as
    // release, not only on the success path.
    expect(result.status).toBe(500);
    const window = spendSince(db, alice.id, 0);
    expect(window.events).toBe(1);
    expect(window.costUsd).toBe(5);
  });

  /**
   * FIX 3 (whole-branch review): a client abort or PREVIEW_PROXY_TIMEOUT_MS
   * resolves the REAL proxyHttp with `{ completed: false }` WITHOUT throwing
   * — the orchestrator subprocess behind it may still be running and still
   * appending to its log. Ingesting now would read a PARTIAL file and then
   * delete it, so every later line lands nowhere. This is the one case that
   * must skip `after()` entirely: no ingest, and no delete either (the
   * eventual startup sweep is what cleans this file up, not this handler).
   */
  it("does not ingest — and does not delete the log file — when the proxy resolves without the exchange completing", async () => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    let capturedPath = "";
    try {
      proxyMocks.impl = async (args) => {
        const usageId = args.setHeaders?.[USAGE_ID_HEADER];
        if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
        // A partial write — standing in for a subprocess still appending when
        // the run timed out — followed by resolving (not throwing) with
        // completed: false, exactly like the real proxyHttp's own
        // PREVIEW_PROXY_TIMEOUT_MS path: it still writes a 504 to the client,
        // but the exchange with the upstream never finished.
        capturedPath = writeUsageLog(usageId, [usageRow({ cost_usd: 7 })]);
        args.res.writeHead(504);
        args.res.end("timed out");
        return { completed: false };
      };

      const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
      expect(result.status).toBe(504);

      // Nothing ingested — the spend from this partial file must NOT be
      // recorded now (it would double-count once the file is eventually
      // ingested some other way, and this file is never ingested any other
      // way today — it is left for usage-log-sweep.ts to clear on the next
      // restart).
      expect(spendSince(db, alice.id, 0)).toEqual({ costUsd: 0, events: 0, unpricedEvents: 0 });
      // And the file itself must survive this request — deleting an
      // un-ingested, still-partial file would lose whatever the subprocess
      // still appends to it after this response returns.
      expect(existsSync(capturedPath)).toBe(true);
    } finally {
      if (capturedPath !== "") rmSync(capturedPath, { force: true });
    }
  });

  /**
   * Fix from code review: `ingestUsageLog`'s result used to be discarded
   * entirely — `skipped`/`unreadable` exist, per that function's own
   * docstring, "precisely so the caller can log them," and the caller did
   * not. These pin that a loss is now surfaced (with enough to act on: the
   * user and project id) and that a clean ingest stays silent, since a log
   * line on every successful regen would be noise an operator learns to
   * ignore.
   */
  it("logs a warning naming the user and project when the ingest loses spend (skipped > 0)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pool = fakePool();
      const { call, project, alice, aliceCookie } = harness(pool);
      proxyMocks.impl = async (args) => {
        const usageId = args.setHeaders?.[USAGE_ID_HEADER];
        if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
        // One valid row and one row missing model/role: ingest-usage.ts
        // counts the second as `skipped`, not a throw — exactly the "lost
        // spend, but silently" shape this warning exists to surface.
        writeUsageLog(usageId, [usageRow({ cost_usd: 1 }), { bogus: true }]);
        args.res.writeHead(200);
        args.res.end("proxied");
        return { completed: true };
      };
      const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
      expect(result.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(alice.id);
      expect(logged).toContain(project.id);
      expect(logged).toMatch(/skipped/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a warning naming the user and project when the usage log is unreadable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let dirPath: string | undefined;
    try {
      const pool = fakePool();
      const { call, project, alice, aliceCookie } = harness(pool);
      proxyMocks.impl = async (args) => {
        const usageId = args.setHeaders?.[USAGE_ID_HEADER];
        if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
        // A directory at the log's path: exists, but unreadable as a file --
        // the same trick ingest-usage.test.ts uses for this exact case.
        dirPath = usageLogPathFor(usageId);
        mkdirSync(dirPath, { recursive: true });
        args.res.writeHead(200);
        args.res.end("proxied");
        return { completed: true };
      };
      const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
      expect(result.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(alice.id);
      expect(logged).toContain(project.id);
      expect(logged).toMatch(/unreadable/i);
    } finally {
      errorSpy.mockRestore();
      if (dirPath !== undefined) rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("does not log anything when the ingest is clean (rows recorded, nothing lost)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pool = fakePool();
      const { call, project, aliceCookie } = harness(pool);
      proxyMocks.impl = async (args) => {
        const usageId = args.setHeaders?.[USAGE_ID_HEADER];
        if (usageId === undefined) throw new Error("expected a usage id header on a billable request");
        writeUsageLog(usageId, [usageRow({ cost_usd: 1 }), usageRow({ cost_usd: 2 })]);
        args.res.writeHead(200);
        args.res.end("proxied");
        return { completed: true };
      };
      const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
      expect(result.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log anything when the child wrote no usage log at all (the legitimate no-op)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pool = fakePool();
      const { call, project, aliceCookie } = harness(pool);
      // beforeEach's default impl never writes a log file for any id.
      const result = await call(billableEntry.method, pathFor(billableEntry, project.id), aliceCookie);
      expect(result.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * Task 4, gap 1: mapping agent-env.ts's/api-keys.ts's typed key-resolution
 * errors to a status, scoped to the four billable entries only. `fakePool`'s
 * `assertApiKeyUsable` defaults to a no-op (every test above relies on
 * that), so these tests override it per case to prove compiler-routes.ts's
 * OWN mapping logic — the real `PreviewPool.assertApiKeyUsable` (does it
 * throw the right typed error for the right stored state) is separately,
 * directly unit-tested in preview-pool.test.ts.
 */
describe("compilerRoutes: API key error mapping", () => {
  it.each(BILLABLE_ENTRIES)(
    "maps MissingApiKeyError to 400 with the error's own message on $method $path, never touching the pool",
    async (entry) => {
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new MissingApiKeyError(); });
      const { call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: new MissingApiKeyError().message });
      expect(pool.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps DisabledUserError to 403 on $method $path, never touching the pool",
    async (entry) => {
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new DisabledUserError(); });
      const { call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: new DisabledUserError().message });
      expect(pool.acquire).not.toHaveBeenCalled();
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps UndecryptableApiKeyError to 500, logs it, and never touches the pool ($method $path)",
    async (entry) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const pool = fakePool();
        pool.assertApiKeyUsable.mockImplementation(() => { throw new UndecryptableApiKeyError(); });
        const { call, project, aliceCookie } = harness(pool);
        const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.body)).toEqual({ error: new UndecryptableApiKeyError().message });
        expect(pool.acquire).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain("undecryptable");
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps UnknownUserError to 500 and never touches the pool ($method $path)",
    async (entry) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const pool = fakePool();
        pool.assertApiKeyUsable.mockImplementation(() => { throw new UnknownUserError(); });
        const { call, project, aliceCookie } = harness(pool);
        const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.body)).toEqual({ error: new UnknownUserError().message });
        expect(pool.acquire).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(COMPILER_ENTRIES.filter((e) => !e.billable))(
    "never checks the API key on a non-billable entry — a keyless user still reaches the proxy ($method $path)",
    async (entry) => {
      // Only billable endpoints need a key (spec, task 4): a preview or an
      // export must keep working for a user with no stored key at all. This
      // proves it structurally — assertApiKeyUsable would refuse EVERY
      // request if it were called, so a 200 here is only possible because
      // the wrapper is never applied to this entry.
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new MissingApiKeyError(); });
      const { call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(200);
      expect(pool.assertApiKeyUsable).not.toHaveBeenCalled();
    },
  );
});

/**
 * Task 4, gap 2: bounding the concurrent-start multiplier. `fakePool`'s
 * `reserveBillableSlot`/`releaseBillableSlot` are a real (if independent)
 * per-user counter — see the module comment on `fakePool` above — so these
 * tests exercise genuine concurrency through the composed route table,
 * matching the brief's own framing: the second concurrent request is
 * allowed, the third refused, and the count drops when a request completes,
 * including when it fails.
 */
describe("compilerRoutes: concurrent-start bound", () => {
  it(`refuses a billable request with 429 once ${MAX_BILLABLE_IN_FLIGHT_PER_USER} are already reserved for that user, never touching the pool`, async () => {
    const pool = fakePool();
    const { call, project, alice, aliceCookie } = harness(pool);
    for (let i = 0; i < MAX_BILLABLE_IN_FLIGHT_PER_USER; i += 1) pool.reserveBillableSlot(alice.id);
    const entry = BILLABLE_ENTRIES[0]!;
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    expect(result.status).toBe(429);
    expect(result.body).toContain(String(MAX_BILLABLE_IN_FLIGHT_PER_USER));
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("never reserves a billable slot for a non-billable entry", async () => {
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    const entry = COMPILER_ENTRIES.find((e) => !e.billable)!;
    await call(entry.method, pathFor(entry, project.id), aliceCookie);
    expect(pool.reserveBillableSlot).not.toHaveBeenCalled();
  });

  it("releases the reservation once a billable request completes, even when the forward call fails", async () => {
    proxyMocks.impl = async () => { throw new Error("boom"); };
    const pool = fakePool();
    const { call, project, alice, aliceCookie } = harness(pool);
    const entry = BILLABLE_ENTRIES[0]!;
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    expect(result.status).toBe(500); // the router's own catch-all
    // If the reservation had leaked, one of these would already be false.
    for (let i = 0; i < MAX_BILLABLE_IN_FLIGHT_PER_USER; i += 1) {
      expect(pool.reserveBillableSlot(alice.id)).toBe(true);
    }
  });

  it("allows a second concurrent billable request but refuses a third, then frees a slot once one of the two finishes — even by failing", async () => {
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    const entry = BILLABLE_ENTRIES[0]!;
    const path = pathFor(entry, project.id);

    // proxyHttp is mocked at module scope; this impl hands back a controller
    // per call so the test can decide exactly when — and how — each of two
    // genuinely concurrent requests finishes.
    const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    proxyMocks.impl = (args) =>
      new Promise<{ completed: boolean }>((resolve, reject) => {
        pending.push({
          resolve: () => { args.res.writeHead(200); args.res.end("proxied"); resolve({ completed: true }); },
          reject,
        });
      });

    const first = call(entry.method, path, aliceCookie);
    const second = call(entry.method, path, aliceCookie);
    // Let both requests actually reach proxyHttp (and so hold their
    // reservation) before the third is sent — everything on the path there
    // is promise-chained with no real I/O, so a single macrotask tick
    // flushes it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(2);

    const third = await call(entry.method, path, aliceCookie);
    expect(third.status).toBe(429);
    expect(pending).toHaveLength(2); // the third never reached the proxy at all

    // The SECOND in-flight request fails outright — proving a reservation is
    // freed on failure, not only on success.
    pending[1]!.reject(new Error("simulated mid-run failure"));
    expect((await second).status).toBe(500);

    // A slot just freed by that failure — a fresh concurrent request is
    // allowed again, alongside the still-unfinished first one.
    const fourth = call(entry.method, path, aliceCookie);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(3);

    pending[0]!.resolve();
    pending[2]!.resolve();
    expect((await first).status).toBe(200);
    expect((await fourth).status).toBe(200);
  });
});
