// server/src/preview-forward.test.ts
/**
 * `forwardToPreview` had no dedicated test file until residual 1 (a
 * whole-branch review, see docs/decisions.md's 2026-08-06 rows). Its own
 * module comment already states the property this file exists to protect:
 * `pool.release()` — and, one layer up in `compiler-routes.ts`,
 * `releaseBillableSlot()` — must not free while the exchange with the
 * preview child is still genuinely going, and the billable `after()` ingest
 * hook must run exactly when, and only when, that exchange actually
 * completed.
 *
 * `compiler-routes.test.ts` mocks `proxyHttp` module-wide, by design (its own
 * header comment says so) — it can prove "release/after wait for
 * proxyHttp's PROMISE," but not "proxyHttp's promise itself doesn't resolve
 * early on a client abort," which is the actual bug residual 1 fixed. That
 * second half can only be shown against a REAL upstream, so this file drives
 * the real (unmocked) `forwardToPreview` + `proxyHttp` against a real
 * `node:http` server, the same way preview-proxy.test.ts does — no mocked
 * sockets, and a fake `PreviewPool` that implements only the handful of
 * methods `forwardToPreview` actually calls.
 */
import * as http from "node:http";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { forwardToPreview, type BillableForward } from "./preview-forward.ts";
import type { PreviewPool } from "./preview-pool.ts";
import type { ProjectHandler } from "./require-project.ts";
import type { Project } from "./projects.ts";
import type { User } from "./users.ts";

/** Polls `predicate` until it is true, or throws after `timeoutMs` — same idiom preview-proxy.test.ts uses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true within timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const project: Project = {
  id: "proj-1", ownerId: "user-1", directory: "proj-1", name: "Test Project", createdAt: Date.now(),
};
const user: User = {
  id: "user-1", email: "alice@example.com", passwordHash: "x", spendCapUsd: 100,
  createdAt: Date.now(), disabledAt: null,
};
const ctx = { project, user } as unknown as Parameters<ProjectHandler>[2];

/** Just enough of PreviewPool's surface for `forwardToPreview` to call — see compiler-routes.test.ts's own `fakePool` for the established idiom of casting a plain object rather than constructing a real PreviewPool. */
function fakePool(port: number): PreviewPool & { acquire: ReturnType<typeof vi.fn>; retain: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  return {
    acquire: vi.fn(async () => ({ projectId: project.id, port, base: "/", inFlight: 0, lastUsedAt: Date.now() })),
    retain: vi.fn(),
    release: vi.fn(),
  } as unknown as PreviewPool & { acquire: ReturnType<typeof vi.fn>; retain: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
}

/** Drives the real, unmocked `forwardToPreview(pool, options)` behind a real node:http server. */
function startForwardServer(
  pool: PreviewPool,
  options?: { billable?: (c: Parameters<ProjectHandler>[2]) => BillableForward },
): Promise<{ origin: string; close: () => Promise<void> }> {
  const handler = forwardToPreview(pool, options);
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      void handler(req, res, ctx);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: async () => { server.close(); await once(server, "close"); },
      });
    });
  });
}

describe("forwardToPreview + real proxyHttp: release/after wait for genuine completion (residual 1)", () => {
  it("does not release the pool, and does not run the billable after() hook, until an aborted exchange genuinely completes upstream", async () => {
    let upstreamRequestReceived = false;
    let finishUpstreamWork!: () => void;
    const workDone = new Promise<void>((resolve) => { finishUpstreamWork = resolve; });
    const holdingUpstream = createServer((req, res) => {
      upstreamRequestReceived = true;
      void workDone.then(() => {
        try {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("done");
        } catch {
          // Only reachable if release() already fired and something torn
          // this connection down underneath — the regression this test
          // exists to catch.
        }
      });
    });
    holdingUpstream.listen(0);
    await once(holdingUpstream, "listening");
    const holdingPort = (holdingUpstream.address() as { port: number }).port;

    const pool = fakePool(holdingPort);
    let afterCalled = false;
    const { origin, close } = await startForwardServer(pool, {
      billable: () => ({ setHeaders: {}, after: () => { afterCalled = true; } }),
    });

    try {
      const controller = new AbortController();
      const fetchPromise = fetch(`${origin}/`, { signal: controller.signal });
      await waitUntil(() => upstreamRequestReceived);
      controller.abort();
      await expect(fetchPromise).rejects.toBeTruthy();

      // A macrotask boundary flushes every microtask the abort itself
      // triggered — deterministic, not a race: `holdingUpstream` cannot
      // answer until `finishUpstreamWork()` is called below, so if
      // `release`/`after` have not fired by now, they structurally cannot
      // have fired for the "genuine completion" reason; they could only be
      // MISSING (still correct) or WRONGLY EARLY (the bug), never late by
      // luck.
      await new Promise((resolve) => setImmediate(resolve));
      expect(pool.release).not.toHaveBeenCalled();
      expect(afterCalled).toBe(false);

      finishUpstreamWork();
      await waitUntil(() => pool.release.mock.calls.length > 0);
      expect(pool.release).toHaveBeenCalledWith(project.id);
      expect(afterCalled).toBe(true);
    } finally {
      await close();
      holdingUpstream.closeAllConnections();
      holdingUpstream.close();
      await once(holdingUpstream, "close");
    }
  });

  it("still releases the pool, but skips the billable after() hook, when the upstream genuinely times out", async () => {
    // Same prototype-patching idiom preview-proxy.test.ts uses to exercise
    // PREVIEW_PROXY_TIMEOUT_MS without a real 15-minute wait.
    let capturedCallback: (() => void) | undefined;
    const spy = vi.spyOn(http.ClientRequest.prototype, "setTimeout")
      .mockImplementation(function (this: http.ClientRequest, _ms: number, cb?: () => void) {
        capturedCallback = cb;
        return this;
      });

    const holdingUpstream = createServer(() => {
      // Deliberately never answers.
    });
    holdingUpstream.listen(0);
    await once(holdingUpstream, "listening");
    const holdingPort = (holdingUpstream.address() as { port: number }).port;

    const pool = fakePool(holdingPort);
    let afterCalled = false;
    const { origin, close } = await startForwardServer(pool, {
      billable: () => ({ setHeaders: {}, after: () => { afterCalled = true; } }),
    });

    try {
      const responsePromise = fetch(`${origin}/`);
      await waitUntil(() => capturedCallback !== undefined);
      capturedCallback!();

      const response = await responsePromise;
      expect(response.status).toBe(504);
      await waitUntil(() => pool.release.mock.calls.length > 0);
      expect(pool.release).toHaveBeenCalledWith(project.id);
      expect(afterCalled).toBe(false);
    } finally {
      spy.mockRestore();
      await close();
      holdingUpstream.closeAllConnections();
      holdingUpstream.close();
      await once(holdingUpstream, "close");
    }
  });
});
