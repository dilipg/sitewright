// server/src/preview-upgrade.test.ts
/**
 * The upgrade handler's own module comment calls it "the ONE authorization
 * path outside the route table" — meaning it is also the one path no
 * route-table test can ever exercise. Before this file existed, deleting the
 * `project.ownerId !== user.id` comparison in `preview-upgrade.ts` turned HMR
 * into an unauthenticated cross-tenant socket with all of this codebase's
 * other tests green. Drives `createPreviewUpgradeListener` directly with a
 * fake socket and a fake pool — no real TCP connection needed, since the
 * property under test is the authorization decision (destroy vs. proxy), not
 * byte shuffling (that is `preview-proxy.test.ts`'s job, against real
 * sockets).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { createProject, type Project } from "./projects.ts";
import type { PreviewPool } from "./preview-pool.ts";

const proxyMocks = vi.hoisted(() => ({
  calls: [] as Array<{ port: number; path: string }>,
}));

// Same idiom as preview-routes.test.ts: preview-upgrade.ts imports
// proxyUpgrade directly, and vitest hoists this above the imports below.
vi.mock("./preview-proxy.ts", () => ({
  proxyUpgrade: (args: { port: number; path: string }) => {
    proxyMocks.calls.push({ port: args.port, path: args.path });
  },
}));

import { createPreviewUpgradeListener } from "./preview-upgrade.ts";

/** A minimal stand-in for the raw Duplex node:http hands an 'upgrade' listener. */
function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  socket.destroy = vi.fn();
  return socket;
}

interface FakePool {
  acquire: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}
function fakePool(
  acquireImpl?: (project: Project, ownerId: string) => Promise<{ port: number; base: string }>,
): FakePool {
  return {
    acquire: vi.fn(acquireImpl ?? (async () => ({ port: 9001, base: "/preview/x/" }))),
    retain: vi.fn(),
    release: vi.fn(),
  };
}

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function harness(pool: FakePool) {
  const dir = mkdtempSync(join(tmpdir(), "server-previewupgrade-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const project = createProject(db, alice.id, "alice-run", "Alice");
  const listener = createPreviewUpgradeListener({ db, pool: pool as unknown as PreviewPool });
  return {
    db, alice, bob, project, listener,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
  };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  proxyMocks.calls = [];
});

/** Lets any already-scheduled microtasks (the listener's internal async IIFE) settle. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createPreviewUpgradeListener", () => {
  it("destroys the socket and never touches the pool when there is no cookie at all", async () => {
    const pool = fakePool();
    const { listener, project } = harness(pool);
    const socket = fakeSocket();
    const req = { url: `/preview/${project.id}/`, headers: { host: "localhost" } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(proxyMocks.calls).toEqual([]);
  });

  it("destroys the socket and never touches the pool for a forged/unknown session cookie", async () => {
    const pool = fakePool();
    const { listener, project } = harness(pool);
    const socket = fakeSocket();
    const req = {
      url: `/preview/${project.id}/`,
      headers: { host: "localhost", cookie: `${SESSION_COOKIE}=not-a-real-session-id` },
    };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(proxyMocks.calls).toEqual([]);
  });

  it("destroys the socket and never touches the pool for a valid session on another user's project", async () => {
    // This is the case that matters most: a real, currently-valid session —
    // just the wrong owner. Asserting `acquire` was never called is what
    // proves the ownership check runs BEFORE any subprocess work, not just
    // that the socket eventually closes.
    const pool = fakePool();
    const { listener, project, bobCookie } = harness(pool);
    const socket = fakeSocket();
    const req = { url: `/preview/${project.id}/`, headers: { host: "localhost", cookie: bobCookie } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(proxyMocks.calls).toEqual([]);
  });

  it("destroys the socket for a nonexistent project id, identically to a foreign one", async () => {
    const pool = fakePool();
    const { listener, aliceCookie } = harness(pool);
    const socket = fakeSocket();
    const req = { url: "/preview/does-not-exist/", headers: { host: "localhost", cookie: aliceCookie } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("proxies the upgrade for the owner, forwarding req.url verbatim (query string included)", async () => {
    const pool = fakePool(async () => ({ port: 8123, base: "/preview/x/" }));
    const { listener, project, aliceCookie } = harness(pool);
    const socket = fakeSocket();
    // The query string is load-bearing: Vite's HMR handshake carries its own
    // ?token=<...>, and a version of this that reconstructed the path from
    // decoded segments would silently drop it.
    const url = `/preview/${project.id}/?token=abc123`;
    const req = { url, headers: { host: "localhost", cookie: aliceCookie } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(pool.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), expect.any(String));
    expect(proxyMocks.calls).toEqual([{ port: 8123, path: url }]);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("destroys the socket when the path is not under /preview/", async () => {
    const pool = fakePool();
    const { listener, aliceCookie } = harness(pool);
    const socket = fakeSocket();
    const req = { url: "/not-preview/abc/", headers: { host: "localhost", cookie: aliceCookie } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("destroys the socket on a malformed percent-escape in the project-id segment", async () => {
    const pool = fakePool();
    const { listener, aliceCookie } = harness(pool);
    const socket = fakeSocket();
    const req = { url: "/preview/%ZZ/", headers: { host: "localhost", cookie: aliceCookie } };
    listener(req as never, socket as never, Buffer.alloc(0));
    await tick();
    expect(socket.destroy).toHaveBeenCalled();
    expect(pool.acquire).not.toHaveBeenCalled();
  });
});
