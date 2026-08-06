// server/src/preview-routes.test.ts
/**
 * Drives the real, composed route table (createRequestListener(previewRoutes
 * (...))) against a FAKE pool and a mocked preview-proxy. The goal here is
 * the ownership/authorization wiring and the retain/release bracketing — NOT
 * proving a real Vite child works behind a real proxy, which is task 4's
 * manual Step 5 against a real project (see the report).
 *
 * `proxyHttp` is mocked rather than faked-by-injection because
 * `previewRoutes` imports it directly (see the brief's interface list): the
 * real function never throws by its own module contract, so "release still
 * runs when the proxy blows up" can only be driven by overriding the mock's
 * implementation for one test.
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
import { createRequestListener } from "./router.ts";
import { MAX_PREVIEWS, PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { previewRoutes } from "./preview-routes.ts";

const proxyMocks = vi.hoisted(() => ({
  impl: async (args: { res: { writeHead: (code: number) => unknown; end: (chunk?: string) => unknown } }) => {
    args.res.writeHead(200);
    args.res.end("proxied");
  },
  calls: [] as Array<{ port: number; path: string }>,
}));

// Vitest hoists vi.mock calls above every import in this file (regardless of
// source order), so preview-routes.ts's own
// `import { proxyHttp } from "./preview-proxy.ts"` resolves to this mock —
// same idiom as auth-routes.test.ts mocking @node-rs/argon2.
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

function harness(pool: FakePool) {
  const dir = mkdtempSync(join(tmpdir(), "server-previewroutes-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const project = createProject(db, alice.id, "alice-run", "Alice");
  const listener = createRequestListener(previewRoutes({ db, pool: pool as unknown as PreviewPool }));

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

describe("GET /preview/:projectId/*", () => {
  it("401s an unauthenticated request and never touches the pool", async () => {
    const pool = fakePool();
    const { call, project } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/`);
    expect(result.status).toBe(401);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("404s another user's project and never touches the pool", async () => {
    const pool = fakePool();
    const { call, project, bobCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/`, bobCookie);
    expect(result.status).toBe(404);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("proxies the owner's request, forwarding the ORIGINAL path unstripped", async () => {
    // Not the wildcard tail with the project-id prefix removed: the child's
    // Vite dev server is spawned with a matching `--base`
    // (`/preview/<projectId>/`) and expects requests to arrive WITH that
    // prefix still attached — a stripped path gets redirected right back to
    // it by Vite itself, which loops the client against its own original URL
    // forever if proxied through unexamined. Found live, against a real Vite
    // child, in task 4's manual verification (see the report).
    const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
    const { call, project, aliceCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/src/main.tsx`, aliceCookie);
    expect(result.status).toBe(200);
    expect(proxyMocks.calls).toEqual([{ port: 7777, path: `/preview/${project.id}/src/main.tsx` }]);
  });

  it("forwards the query string verbatim", async () => {
    // Load-bearing for HMR, not cosmetic: Vite's own HMR client opens its
    // socket with a token in the query (`?token=<...>`), so a version of this
    // that rebuilt the path from `ctx.params["*"]` or from `url.pathname`
    // would drop it, break the handshake, and leave every other test green.
    const pool = fakePool(async () => ({ port: 7777, base: "/preview/x/" }));
    const { call, project, aliceCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/src/main.tsx?t=1720000000&token=abc`, aliceCookie);
    expect(result.status).toBe(200);
    expect(proxyMocks.calls).toEqual([
      { port: 7777, path: `/preview/${project.id}/src/main.tsx?t=1720000000&token=abc` },
    ]);
  });

  it("acquires with the caller's project and owner id", async () => {
    const pool = fakePool();
    const { call, project, alice, aliceCookie } = harness(pool);
    await call("GET", `/preview/${project.id}/`, aliceCookie);
    expect(pool.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), alice.id);
  });

  it("maps PreviewCapacityError to 503 naming the cap", async () => {
    const pool = fakePool(async () => { throw new PreviewCapacityError(); });
    const { call, project, aliceCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/`, aliceCookie);
    expect(result.status).toBe(503);
    expect(result.body).toContain(String(MAX_PREVIEWS));
    expect(proxyMocks.calls).toEqual([]);
  });

  it("maps any other spawn failure to 500 with no stack trace or environment value in the body", async () => {
    const secretMarker = "sk-ant-super-secret-leak-marker";
    const pool = fakePool(async () => {
      throw new Error(`spawn failed: ${secretMarker}\n    at Object.<anonymous> (/some/stack/trace.ts:1:1)`);
    });
    const { call, project, aliceCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/`, aliceCookie);
    expect(result.status).toBe(500);
    expect(result.body).not.toContain(secretMarker);
    expect(result.body).not.toContain("at Object.<anonymous>");
  });

  it("releases the preview even when the proxy call rejects", async () => {
    proxyMocks.impl = async () => { throw new Error("proxy exploded"); };
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    const result = await call("GET", `/preview/${project.id}/`, aliceCookie);
    // The router's own top-level catch turns the re-thrown error into a 500 —
    // the property under test is that release() still ran despite it.
    expect(result.status).toBe(500);
    expect(pool.retain).toHaveBeenCalledWith(project.id);
    expect(pool.release).toHaveBeenCalledWith(project.id);
  });

  it("retains before proxying and releases after, on the success path too", async () => {
    const pool = fakePool();
    const { call, project, aliceCookie } = harness(pool);
    await call("GET", `/preview/${project.id}/`, aliceCookie);
    expect(pool.retain).toHaveBeenCalledWith(project.id);
    expect(pool.release).toHaveBeenCalledWith(project.id);
  });
});
