// server/src/shutdown.ts
/**
 * The shutdown ordering, extracted out of `scripts/serve.ts` so it is testable
 * at all — the same reason, and the same precedent, as `preview-upgrade.ts`
 * (`scripts/serve.ts`'s module body cannot be imported for a unit test: it
 * parses `process.argv`, may `process.exit`, opens a real database and binds a
 * real port; see `compose.test.ts`'s own comment).
 *
 * WHY THIS EXISTS AS A MODULE RATHER THAN A `.then()` CHAIN.
 *
 * `serve.ts` used to shut down as `jobWorker.stop().then(() => pool.shutdown())`,
 * which is correct in ordering and wrong in dependency: preview-child cleanup
 * was CHAINED BEHIND a wait whose length is a policy decision made elsewhere.
 * That made two goals compete which need not:
 *
 *   - `JobWorker.stop()` waits `SHUTDOWN_PROXIED_WAIT_MS` (25s) when only
 *     proxied jobs are in flight, so a section regen (~27s measured) has a
 *     real chance to finish rather than being killed mid-`write_section_only`.
 *   - Preview children must never OUTLIVE this process. They are ordinary
 *     spawned children: nothing on Linux or Windows kills them when their
 *     parent dies, so if SIGKILL lands before `pool.shutdown()` runs, they
 *     survive holding ports — and whatever orchestrator subprocess one of them
 *     spawned keeps spending against a usage log the next boot sweeps unread.
 *
 * Chained, a wait longer than the supervisor's grace means SIGKILL lands DURING
 * the wait and `pool.shutdown()` never runs at all. Decoupled, cleanup gets its
 * own bound: a watchdog armed the moment shutdown begins, which force-runs
 * `shutdownPool` at `POOL_CLEANUP_WATCHDOG_MS` if the worker has not returned
 * by then.
 *
 * THE WATCHDOG IS A BACKSTOP, NOT A COMPETITOR — and getting that wrong once is
 * why `shutdown-budget.ts` exists. A watchdog bound SHORTER than the wait it
 * is protecting against kills the preview child the waiting job depends on, so
 * the wait can never pay off under any grace. Every deadline is therefore
 * derived from one operator-declared number, preserving
 * `proxiedWaitMs < watchdogMs < graceMs`: `stop()` returns on its own first,
 * and this fires only if it overruns its own bound entirely.
 *
 * IT STILL FIRES SOMETIMES, AND KILLING PREVIEW CHILDREN WHILE A JOB IS IN
 * FLIGHT IS THEN THE INTENDED OUTCOME, NOT A BUG — stated because it looks like
 * one and the next reader will be tempted to "fix" it back. At that point the
 * grace is nearly exhausted; a job that dies mid-run becomes an honest
 * `interrupted` row at the next boot (`markRunningJobsInterrupted`), a
 * designed and resumable state, whereas an orphaned child is an unbounded one
 * nothing ever cleans up.
 *
 * Cleanup runs AT MOST ONCE (`cleanupOnce` memoises the promise, not a
 * boolean, so a concurrent watchdog and normal path await the same call), and
 * AT LEAST ONCE: it runs even when `stopWorker` rejects, and that rejection is
 * re-thrown afterwards rather than swallowed, so `serve.ts` still exits
 * non-zero for it.
 */
import { DEFAULT_SHUTDOWN_GRACE_MS, deriveShutdownBudget } from "./shutdown-budget.ts";

/**
 * How long shutdown will wait for the job worker before killing preview
 * children anyway — the DEFAULT only, for a caller that declares no grace.
 * `scripts/serve.ts` passes the value derived from the operator's own
 * `WEBGEN_SHUTDOWN_GRACE_MS` instead.
 *
 * At the documented 10s floor this is 8000ms, leaving `CLEANUP_RESERVE_MS` for
 * the kills themselves and `process.exit`. Three ordering relationships make it
 * work, all pinned by tests in shutdown.test.ts rather than left to inspection:
 * it is GREATER than `SHUTDOWN_PROXIED_WAIT_MS` (so the job's own wait expires
 * first and this stays a backstop), LESS than the grace (so cleanup finishes),
 * and at least `SHUTDOWN_WAIT_MS + SHUTDOWN_KILL_GRACE_MS` (5s + 2s = 7s), so a
 * tracked orchestrator run's WHOLE SIGTERM-plus-recovery sequence — the path
 * that puts ~$1-2 of real spend into `usage_event` instead of leaving it for
 * the sweeper — completes before this could ever cut it short.
 */
export const POOL_CLEANUP_WATCHDOG_MS = deriveShutdownBudget(DEFAULT_SHUTDOWN_GRACE_MS).watchdogMs;

export interface ShutdownSequenceDeps {
  /** `JobWorker.stop()` — bounded by its own two waits, see job-worker.ts. */
  stopWorker: () => Promise<void>;
  /** `PreviewPool.shutdown()` — kills every preview child. */
  shutdownPool: () => Promise<void>;
  /** Defaults to `POOL_CLEANUP_WATCHDOG_MS`. Overridable so a test can prove the watchdog without waiting 8s for it. */
  watchdogMs?: number;
}

/**
 * Returns the shutdown routine `serve.ts` runs on SIGINT/SIGTERM. Safe to call
 * more than once in the sense that matters: the pool is shut down at most once
 * across every call and every watchdog firing.
 */
export function createShutdownSequence(deps: ShutdownSequenceDeps): () => Promise<void> {
  const watchdogMs = deps.watchdogMs ?? POOL_CLEANUP_WATCHDOG_MS;
  // The PROMISE is memoised, not a boolean flag: a watchdog that fires while
  // the normal path is already inside `shutdownPool` must await that same
  // call, not start a second one against a pool mid-teardown.
  let cleanup: Promise<void> | undefined;
  const cleanupOnce = (): Promise<void> => {
    cleanup ??= deps.shutdownPool();
    return cleanup;
  };

  return async (): Promise<void> => {
    const timer = setTimeout(() => {
      console.warn(
        `[shutdown] the job worker has not finished after ${String(watchdogMs)}ms; `
        + "killing preview children now rather than risk being SIGKILLed with them still running "
        + "— a job still in flight becomes an interrupted row at the next boot",
      );
      // Attached so a rejection here is never an unhandled one; the awaiting
      // path below still sees it, because it awaits the same memoised promise.
      void cleanupOnce().catch(() => undefined);
    }, watchdogMs);
    // Both belt and braces, deliberately: unref()'d so this timer can never be
    // the reason the process stays alive (the rule serve.ts's reaper interval
    // and job-worker's own raceWithTimeout already follow), AND cleared on
    // every exit path below so it cannot log a false alarm after a clean stop.
    timer.unref?.();

    let workerError: unknown;
    let workerFailed = false;
    try {
      await deps.stopWorker();
    } catch (err) {
      // Not rethrown here: cleanup must still run. Rethrown at the end, so
      // serve.ts's own catch still turns it into a non-zero exit.
      workerError = err;
      workerFailed = true;
    } finally {
      clearTimeout(timer);
    }

    await cleanupOnce();
    if (workerFailed) throw workerError;
  };
}
