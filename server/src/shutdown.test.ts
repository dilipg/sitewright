// server/src/shutdown.test.ts
/**
 * The property this file exists for: preview-child cleanup must NOT be
 * chained behind however long the job worker decides to wait.
 *
 * Chained, `JobWorker.stop()`'s 25s proxied wait meant that under a supervisor
 * grace at the 10s floor `scripts/serve.ts` itself documents, SIGKILL landed
 * mid-wait and `pool.shutdown()` never ran — leaving Vite children alive with
 * no parent, holding ports, and (via whatever orchestrator subprocess one of
 * them spawned) still spending against a usage log the next boot sweeps
 * unread. That is strictly worse than the 5s behaviour it replaced, which is
 * why the fix is a watchdog rather than a smaller number.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SHUTDOWN_KILL_GRACE_MS, SHUTDOWN_PROXIED_WAIT_MS, SHUTDOWN_WAIT_MS,
} from "./job-worker.ts";
import { DEFAULT_SHUTDOWN_GRACE_MS } from "./shutdown-budget.ts";
import { createShutdownSequence, POOL_CLEANUP_WATCHDOG_MS } from "./shutdown.ts";

/** A promise plus the handle to settle it — the standard shape for "hold this open until the test says so". */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createShutdownSequence", () => {
  it("shuts the pool down AFTER the worker stops, on the normal path", async () => {
    const order: string[] = [];
    const run = createShutdownSequence({
      stopWorker: async () => { await Promise.resolve(); order.push("worker stopped"); },
      shutdownPool: async () => { await Promise.resolve(); order.push("pool shut down"); },
      watchdogMs: 5_000,
    });

    await run();

    // A job mid-run must not have the child its exchange depends on killed out
    // from under it while the worker is still waiting for it (spec decision
    // 13) — the ordering serve.ts used to enforce by hand.
    expect(order).toEqual(["worker stopped", "pool shut down"]);
  });

  it("kills preview children at the watchdog bound even though the worker has NOT returned", async () => {
    const worker = deferred();
    const shutdownPool = vi.fn(async () => { await Promise.resolve(); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Never resolves on its own — stands in for stop()'s 25s proxied wait, the
    // exact case that used to leave cleanup unreachable under a short grace.
    const run = createShutdownSequence({
      stopWorker: () => worker.promise,
      shutdownPool,
      watchdogMs: 30,
    });

    try {
      const finished = run();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // THE load-bearing assertion: the children are already dead while the
      // worker is still going. Chained behind stop(), this is 0.
      expect(shutdownPool).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();

      worker.resolve();
      await finished;
      // ...and the normal path did not then kill them a second time.
      expect(shutdownPool).toHaveBeenCalledTimes(1);
    } finally {
      worker.resolve();
      warn.mockRestore();
    }
  });

  it("logs no watchdog warning when the worker stops in time — the timer is cleared, not merely deduplicated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shutdownPool = vi.fn(async () => { await Promise.resolve(); });
    const run = createShutdownSequence({
      stopWorker: async () => { await Promise.resolve(); },
      shutdownPool,
      watchdogMs: 20,
    });

    try {
      await run();
      // Well past the watchdog bound: an uncleared timer still fires here, and
      // `cleanupOnce`'s memo would hide it from the call count — the operator
      // would see a false "the job worker has not finished" alarm on every
      // clean shutdown, and nothing else in this file would catch it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(warn).not.toHaveBeenCalled();
      expect(shutdownPool).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("still shuts the pool down when the worker's own stop() rejects, and re-throws so the exit code stays non-zero", async () => {
    const shutdownPool = vi.fn(async () => { await Promise.resolve(); });
    const boom = new Error("worker blew up");
    const run = createShutdownSequence({
      stopWorker: () => Promise.reject(boom),
      shutdownPool,
      watchdogMs: 5_000,
    });

    // Swallowing the error would leave serve.ts exiting 0 on a failed
    // shutdown, which a supervisor reads as "do not restart"; skipping cleanup
    // would orphan every child.
    await expect(run()).rejects.toBe(boom);
    expect(shutdownPool).toHaveBeenCalledTimes(1);
  });

  it("shuts the pool down exactly once across repeated calls", async () => {
    const shutdownPool = vi.fn(async () => { await Promise.resolve(); });
    const run = createShutdownSequence({
      stopWorker: async () => { await Promise.resolve(); },
      shutdownPool,
      watchdogMs: 5_000,
    });

    await run();
    await run();

    expect(shutdownPool).toHaveBeenCalledTimes(1);
  });
});

/**
 * The three shutdown budgets are injected in every behavioural test in this
 * package, so until now NOTHING failed if a production value changed — 25s
 * could become 5s, or the watchdog could drift past the wait it protects
 * against, with a green suite. These pin the values AND, more importantly, the
 * two orderings the decoupling actually depends on.
 */
describe("shutdown budgets", () => {
  it("pins the DEFAULT values — the documented 10s floor, for an operator who declares nothing", () => {
    expect(SHUTDOWN_WAIT_MS).toBe(5_000);
    expect(SHUTDOWN_KILL_GRACE_MS).toBe(2_000);
    expect(POOL_CLEANUP_WATCHDOG_MS).toBe(8_000);
    // 5s, not 25s: derived from the 10s floor. Far short of a 27s regen, which
    // is the honest default — see shutdown-budget.ts. It only grows when an
    // operator declares a larger grace.
    expect(SHUTDOWN_PROXIED_WAIT_MS).toBe(5_000);
  });

  it("expires the job's own wait BEFORE the watchdog, so the watchdog stays a backstop", () => {
    // The inverse of this ordering is the defect shutdown-budget.ts exists for:
    // a watchdog that fires FIRST kills the preview child the waiting job
    // depends on, so the wait can never pay off under any grace and is dead
    // machinery. Pinned in the direction that makes the wait reachable.
    expect(SHUTDOWN_PROXIED_WAIT_MS).toBeLessThan(POOL_CLEANUP_WATCHDOG_MS);
  });

  it("leaves room for a generate's WHOLE spend-recovery sequence before the watchdog fires", () => {
    // SIGTERM the orchestrator child, then wait the grace so `runGenerateJob`
    // reaches its own ingestUsageLog + finishJob — that is the path that puts
    // ~$1-2 of real spend into `usage_event` instead of leaving it for the
    // next boot's sweeper. Cutting it short with a pool kill would recreate
    // exactly the money-loss bug the bounded stop() was introduced to fix.
    expect(SHUTDOWN_WAIT_MS + SHUTDOWN_KILL_GRACE_MS).toBeLessThanOrEqual(POOL_CLEANUP_WATCHDOG_MS);
  });

  it("finishes cleanup inside the declared grace, with time left to actually kill and exit", () => {
    expect(POOL_CLEANUP_WATCHDOG_MS).toBeLessThan(DEFAULT_SHUTDOWN_GRACE_MS);
  });
});
