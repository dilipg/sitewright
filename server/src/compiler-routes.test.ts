// server/src/compiler-routes.test.ts
/**
 * Drives the real, composed route table
 * (createRequestListener(compilerRoutes(...))) against a FAKE pool and a
 * mocked preview-proxy — the same idiom preview-routes.test.ts uses, for the
 * entries that still proxy synchronously through this layer.
 *
 * SLICE 5 (the job model): the five long-running entries — /__regen,
 * /__regen-page, /__add-section, /__edit-prompt, /__export — no longer proxy
 * from THIS layer at all; they enqueue a job and answer 202 `{jobId}`
 * immediately. The usage-id-header / ingest-on-completion machinery this
 * file used to test here (a `billableForward` built on `forwardToPreview`'s
 * own `billable` hook) moved, unchanged in shape, into job-worker.ts's
 * `runProxiedJob` — see job-worker.test.ts for that coverage, including the
 * "still ingests when the exchange fails" and "skips ingest on an incomplete
 * exchange" properties. Likewise "releases the preview even when the proxy
 * call rejects" no longer has anything to prove for an async entry (there is
 * no proxy call at this layer for one any more) — that test below now uses
 * two SYNCHRONOUS entries instead.
 *
 * What remains here: mounting (bidirectional against the registry),
 * authorization (401/404) across every entry, the enqueue itself (202 + a
 * real, correctly-shaped job row) for the five async entries, synchronous
 * forwarding (unchanged) for every entry that stayed synchronous, and the
 * spend-cap / API-key gates on the four billable entries (all of which are
 * also async, but the gates themselves — requireApiKey, requireBudget — sit
 * in front of the SAME `inner` handler regardless of what it does).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createProject, type Project } from "./projects.ts";
import { findJobById, listJobsByProject } from "./jobs.ts";
import { recordUsageEvent } from "./usage.ts";
import { createRequestListener } from "./router.ts";
import { MAX_PREVIEWS, PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { compilerRoutes } from "./compiler-routes.ts";
import { DisabledUserError, MissingApiKeyError, UnknownUserError } from "./agent-env.ts";
import { UndecryptableApiKeyError } from "./api-keys.ts";

const proxyMocks = vi.hoisted(() => ({
  // Return type matches the REAL proxyHttp's contract (FIX 3): `{ completed
  // }`, not bare `void`.
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
// (reached via forwardToPreview, used by every SYNCHRONOUS entry) resolves
// to this mock — same idiom preview-routes.test.ts uses.
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
}

// No reserveBillableSlot/releaseBillableSlot here (unlike this file's
// pre-slice-5 fakePool): compiler-routes.ts no longer calls either — the
// concurrent-start bound they implemented moved to jobs.ts's `claimNextJob`
// (see that function's own comment) — so a fake that still offered them
// would be testing a mechanism this file's subject no longer uses. Same
// idiom job-worker.test.ts's own fakePool already adopted for the identical
// reason.
function fakePool(acquireImpl?: (project: Project, ownerId: string) => Promise<{ port: number; base: string }>): FakePool {
  return {
    acquire: vi.fn(acquireImpl ?? (async () => ({ port: 6001, base: "/preview/x/" }))),
    retain: vi.fn(),
    release: vi.fn(),
    assertApiKeyUsable: vi.fn(),
  };
}

/** Every /__* entry in the registry — what compilerRoutes is supposed to derive its output from. */
const COMPILER_ENTRIES = PROJECT_SCOPED_ENDPOINTS.filter((e) => e.path.startsWith("/__"));
const BILLABLE_ENTRIES = COMPILER_ENTRIES.filter((e) => e.billable);
const ASYNC_ENTRIES = COMPILER_ENTRIES.filter((e) => e.async);
const SYNC_ENTRIES = COMPILER_ENTRIES.filter((e) => !e.async);

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

  // `body` is JSON.stringified as usual; `raw`, when given, bypasses that and
  // is sent as-is — the only way to put non-JSON bytes on the wire, needed to
  // prove the enqueue path's own malformed-body handling.
  async function call(method: string, path: string, cookie?: string, body?: unknown, raw?: Buffer) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const payload = raw !== undefined ? [raw] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(
      (async function* () { yield* payload; })(),
      { method, url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) } },
    );
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

  it.each(SYNC_ENTRIES)("proxies $method $path for the owner, forwarding req.url verbatim including the query string", async (entry) => {
    const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
    const { call, project, alice, aliceCookie } = harness(pool);
    const base = pathFor(entry, project.id);
    // Extra query params beyond the project id, appended the same way Vite's
    // own HMR client appends `?token=...`: a version that rebuilt the path
    // instead of forwarding req.url verbatim would drop these.
    const requestPath = `${base}${base.includes("?") ? "&" : "?"}extra=1&token=abc`;
    const result = await call(entry.method, requestPath, aliceCookie);
    expect(result.status).toBe(200);
    // No SYNC entry is billable any more (every billable entry is also
    // async, see project-registry.ts), so no synchronous forward ever
    // carries a usage-id header — unlike before slice 5, this is now always
    // undefined, not conditional.
    expect(proxyMocks.calls).toEqual([{ port: 7777, path: requestPath, setHeaders: undefined }]);
    expect(pool.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), alice.id);
  });

  it.each(ASYNC_ENTRIES)("enqueues $method $path for the owner, returning 202 with a real job row, and never touches the pool", async (entry) => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    const payload = { instruction: "make it bigger", route: "/pricing" };
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie, payload);

    expect(result.status).toBe(202);
    const parsed = JSON.parse(result.body) as { jobId: string };
    expect(typeof parsed.jobId).toBe("string");
    expect(parsed.jobId.length).toBeGreaterThan(0);

    const job = findJobById(db, parsed.jobId);
    expect(job).not.toBeNull();
    expect(job?.userId).toBe(alice.id);
    expect(job?.projectId).toBe(project.id);
    expect(job?.status).toBe("queued");
    // The exact body the client sent, round-tripped through JSON — this is
    // the payload job-worker.ts will later replay to the child verbatim.
    expect(job?.requestJson).toBe(JSON.stringify(payload));

    // No proxy call, no pool interaction: the work has not happened yet.
    expect(proxyMocks.calls).toEqual([]);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it.each(ASYNC_ENTRIES)("rejects a malformed-JSON body on $method $path with 400, creating no job", async (entry) => {
    const pool = fakePool();
    const { db, call, project, aliceCookie } = harness(pool);
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie, undefined, Buffer.from("not valid json"));
    expect(result.status).toBe(400);
    expect(listJobsByProject(db, project.id, 10)).toEqual([]);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("does not gate the async-but-non-billable /__export on the spend cap — a user over the cap still gets 202", async () => {
    const pool = fakePool();
    const { db, call, project, alice, aliceCookie } = harness(pool);
    recordUsageEvent(db, {
      userId: alice.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 999, at: Date.now(),
    });
    const entry = ASYNC_ENTRIES.find((e) => e.path === "/__export")!;
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    // Exporting spends nothing, so refusing to even ENQUEUE it over the cap
    // would strand a user's finished work behind a bill (spec, binding
    // constraint) — same reasoning as /__export-download below, just at the
    // enqueue step instead of the proxy step.
    expect(result.status).toBe(202);
  });

  it("does not gate the synchronous /__export-download on the spend cap — a user over the cap still reaches the proxy", async () => {
    const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
    const { db, call, project, alice, aliceCookie } = harness(pool);
    recordUsageEvent(db, {
      userId: alice.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 999, at: Date.now(),
    });
    const entry = SYNC_ENTRIES.find((e) => e.path === "/__export-download")!;
    const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
    expect(result.status).toBe(200);
    expect(pool.acquire).toHaveBeenCalled();
  });

  it.each([
    SYNC_ENTRIES.find((e) => e.path === "/__plan")!,
    SYNC_ENTRIES.find((e) => e.path === "/__regen-revert")!,
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
 * Task 4, gap 1: mapping agent-env.ts's/api-keys.ts's typed key-resolution
 * errors to a status, scoped to the four billable entries only. `fakePool`'s
 * `assertApiKeyUsable` defaults to a no-op (every test above relies on
 * that), so these tests override it per case to prove compiler-routes.ts's
 * OWN mapping logic — the real `PreviewPool.assertApiKeyUsable` (does it
 * throw the right typed error for the right stored state) is separately,
 * directly unit-tested in preview-pool.test.ts.
 *
 * Unaffected by slice 5: requireApiKey wraps the SAME `inner` handler
 * (enqueue, for these four) that requireBudget wraps — a key failure short-
 * circuits before either requireBudget or the enqueue ever runs, exactly as
 * it short-circuited before `billableForward` before this slice.
 */
describe("compilerRoutes: API key error mapping", () => {
  it.each(BILLABLE_ENTRIES)(
    "maps MissingApiKeyError to 400 with the error's own message on $method $path, creating no job",
    async (entry) => {
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new MissingApiKeyError(); });
      const { db, call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: new MissingApiKeyError().message });
      expect(pool.acquire).not.toHaveBeenCalled();
      expect(listJobsByProject(db, project.id, 10)).toEqual([]);
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps DisabledUserError to 403 on $method $path, creating no job",
    async (entry) => {
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new DisabledUserError(); });
      const { db, call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: new DisabledUserError().message });
      expect(pool.acquire).not.toHaveBeenCalled();
      expect(listJobsByProject(db, project.id, 10)).toEqual([]);
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps UndecryptableApiKeyError to 500, logs it, and creates no job ($method $path)",
    async (entry) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const pool = fakePool();
        pool.assertApiKeyUsable.mockImplementation(() => { throw new UndecryptableApiKeyError(); });
        const { db, call, project, aliceCookie } = harness(pool);
        const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.body)).toEqual({ error: new UndecryptableApiKeyError().message });
        expect(pool.acquire).not.toHaveBeenCalled();
        expect(listJobsByProject(db, project.id, 10)).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
        const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain("undecryptable");
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(BILLABLE_ENTRIES)(
    "maps UnknownUserError to 500 and creates no job ($method $path)",
    async (entry) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const pool = fakePool();
        pool.assertApiKeyUsable.mockImplementation(() => { throw new UnknownUserError(); });
        const { db, call, project, aliceCookie } = harness(pool);
        const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.body)).toEqual({ error: new UnknownUserError().message });
        expect(pool.acquire).not.toHaveBeenCalled();
        expect(listJobsByProject(db, project.id, 10)).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(COMPILER_ENTRIES.filter((e) => !e.billable))(
    "never checks the API key on a non-billable entry — a keyless user still reaches the proxy or the enqueue ($method $path)",
    async (entry) => {
      // Only billable endpoints need a key (spec, task 4): a preview, an
      // export, or reading a plan must keep working for a user with no
      // stored key at all. This proves it structurally — assertApiKeyUsable
      // would refuse EVERY request if it were called, so success here is
      // only possible because the wrapper is never applied to this entry.
      // "Success" means 200 for a still-synchronous entry, 202 for the one
      // non-billable ASYNC entry (/__export).
      const pool = fakePool();
      pool.assertApiKeyUsable.mockImplementation(() => { throw new MissingApiKeyError(); });
      const { call, project, aliceCookie } = harness(pool);
      const result = await call(entry.method, pathFor(entry, project.id), aliceCookie);
      expect(result.status).toBe(entry.async ? 202 : 200);
      expect(pool.assertApiKeyUsable).not.toHaveBeenCalled();
    },
  );
});
