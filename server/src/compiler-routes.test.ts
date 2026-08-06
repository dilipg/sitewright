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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createProject, type Project } from "./projects.ts";
import { recordUsageEvent } from "./usage.ts";
import { createRequestListener } from "./router.ts";
import { MAX_PREVIEWS, PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { compilerRoutes } from "./compiler-routes.ts";

const proxyMocks = vi.hoisted(() => ({
  impl: async (args: { res: { writeHead: (code: number) => unknown; end: (chunk?: string) => unknown } }) => {
    args.res.writeHead(200);
    args.res.end("proxied");
  },
  calls: [] as Array<{ port: number; path: string }>,
}));

// Vitest hoists vi.mock calls above every import in this file, so
// compiler-routes.ts's own `import { proxyHttp } from "./preview-proxy.ts"`
// resolves to this mock — same idiom preview-routes.test.ts uses.
vi.mock("./preview-proxy.ts", () => ({
  proxyHttp: (args: { req: unknown; res: unknown; port: number; path: string }) => {
    proxyMocks.calls.push({ port: args.port, path: args.path });
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
}

function fakePool(acquireImpl?: (project: Project, ownerId: string) => Promise<{ port: number; base: string }>): FakePool {
  return {
    acquire: vi.fn(acquireImpl ?? (async () => ({ port: 6001, base: "/preview/x/" }))),
    retain: vi.fn(),
    release: vi.fn(),
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
    expect(proxyMocks.calls).toEqual([{ port: 7777, path: requestPath }]);
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
