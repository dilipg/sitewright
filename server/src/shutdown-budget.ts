// server/src/shutdown-budget.ts
/**
 * One operator-declared number — the supervisor grace this process actually
 * runs under — from which every shutdown deadline is DERIVED, rather than three
 * constants independently guessing at it.
 *
 * WHY THIS EXISTS. Shutdown has two goals that look independent and are not:
 *
 *   1. Let an in-flight proxied job finish. A section regen measures ~27s
 *      (docs/reports/m7-wall-clock.md), so "let it finish" means waiting tens
 *      of seconds.
 *   2. Never let a preview child outlive this process. They are ordinary
 *      spawned children — nothing on Linux or Windows kills them when their
 *      parent dies — so if SIGKILL lands before `PreviewPool.shutdown()` runs,
 *      they survive holding ports.
 *
 * The first attempt bounded them separately: `JobWorker.stop()` waited 25s for
 * a proxied job, and `shutdown.ts` armed an 8s watchdog to force cleanup
 * regardless. That is provably self-defeating, and the reason is worth keeping:
 * THE WATCHDOG KILLS THE VERY PREVIEW CHILD THE WAITING JOB DEPENDS ON. At 8s
 * the child dies, the job's exchange errors, `stop()` returns — so the 25s wait
 * could never pay off under ANY grace, and ~40 lines of machinery could
 * provably never fire.
 *
 * They are irreconcilable only because the process cannot DISCOVER its grace.
 * Told the grace, they reconcile exactly:
 *
 *     proxiedWaitMs  <  watchdogMs  <  graceMs
 *
 * The job's wait expires strictly before the watchdog, so the watchdog is a
 * genuine backstop (it fires only if `stop()` overruns its own bound at all)
 * rather than a competitor; and the watchdog completes strictly before the
 * grace ends, so cleanup always happens.
 *
 * BE CLEAR ABOUT WHAT THE DEFAULT BUYS, WHICH IS NOTHING. At the documented
 * floor (10s) this yields an 8s watchdog and a 5s proxied wait — 5s is far
 * short of a 27s regen, so an operator who declares nothing gets exactly the
 * old behaviour: the job IS killed partway, and it is recovered as an
 * `interrupted` row at the next boot plus `POST /api/jobs/:id/resume`. The
 * differentiated wait only becomes a real improvement once an operator
 * declares a grace big enough to contain it (30s → a 28s watchdog and a 25s
 * wait, which does let a regen already partway through finish). That is
 * configuration, not a free win, and this comment says so rather than
 * implying otherwise.
 */

export const SHUTDOWN_GRACE_ENV_VAR = "WEBGEN_SHUTDOWN_GRACE_MS";

/**
 * The floor, and the default. `scripts/serve.ts` documents "a typical 10-30s
 * supervisor grace"; this is the bottom of that range, so an operator who sets
 * nothing gets the safe end of what this repo already assumed rather than an
 * optimistic guess. It is also a hard MINIMUM — see `loadShutdownBudget`, which
 * refuses to boot below it, because under ~10s the derived watchdog no longer
 * contains a generate's own spend-recovery sequence.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Held back between the watchdog firing and the grace expiring, for the kills
 * themselves (`killWithEscalation` per child) and `process.exit`. Cleanup that
 * *starts* exactly at the grace boundary is cleanup that does not finish.
 */
export const CLEANUP_RESERVE_MS = 2_000;

/**
 * Held back between the proxied wait expiring and the watchdog firing. The wait
 * expiring is not the end of `stop()`: it still logs, returns, and lets
 * `shutdown.ts` run cleanup on the normal path. This is the room for that, and
 * it is what keeps the watchdog a backstop rather than the usual path.
 */
export const WAIT_RESERVE_MS = 3_000;

export interface ShutdownBudget {
  /** What the operator declared (or the floor). */
  graceMs: number;
  /** `shutdown.ts`'s watchdog: force preview cleanup if the worker has not returned. */
  watchdogMs: number;
  /** `JobWorker.stop()`'s wait when only proxied jobs are in flight. */
  proxiedWaitMs: number;
}

/**
 * Pure derivation, exported separately from the env-reading loader so the
 * arithmetic can be tested over a range of graces without touching
 * `process.env` — and so `job-worker.ts` and `shutdown.ts` can each derive
 * their own default from `DEFAULT_SHUTDOWN_GRACE_MS` without either one
 * importing the other.
 *
 * Throws on a grace that cannot produce a valid ordering. That is a programmer
 * error rather than an operator one — `loadShutdownBudget` rejects an
 * out-of-range value first, with a message aimed at a human — but it is
 * checked here too, because this function's whole contract is the ordering and
 * a caller must never receive a budget that silently violates it.
 */
export function deriveShutdownBudget(graceMs: number): ShutdownBudget {
  const watchdogMs = graceMs - CLEANUP_RESERVE_MS;
  const proxiedWaitMs = watchdogMs - WAIT_RESERVE_MS;
  if (!(proxiedWaitMs > 0 && proxiedWaitMs < watchdogMs && watchdogMs < graceMs)) {
    throw new Error(
      `shutdown-budget: a grace of ${String(graceMs)}ms cannot produce a valid ordering `
      + `(proxied wait ${String(proxiedWaitMs)}ms < watchdog ${String(watchdogMs)}ms < grace ${String(graceMs)}ms)`,
    );
  }
  return { graceMs, watchdogMs, proxiedWaitMs };
}

/**
 * Reads and validates `WEBGEN_SHUTDOWN_GRACE_MS`, or falls back to the floor.
 *
 * Refuses loudly rather than degrading, the same call `loadMasterKey` makes for
 * the same reason: a silently-clamped or silently-ignored grace produces a
 * shutdown ordering nobody chose, and the failure it causes (an orphaned Vite
 * child holding a port, or a job killed partway) surfaces minutes later and
 * somewhere else entirely.
 */
export function loadShutdownBudget(env: NodeJS.ProcessEnv = process.env): ShutdownBudget {
  const raw = env[SHUTDOWN_GRACE_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return deriveShutdownBudget(DEFAULT_SHUTDOWN_GRACE_MS);

  // `Number` and not `parseInt`: `parseInt("30s")` is 30, and an operator who
  // wrote a unit meant something this process would then get wrong by three
  // orders of magnitude. Number("30s") is NaN, which this rejects.
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `${SHUTDOWN_GRACE_ENV_VAR} must be an integer number of MILLISECONDS; got ${JSON.stringify(raw)}. `
      + "A unit suffix is not accepted — write 30000, not \"30s\".",
    );
  }
  if (parsed < DEFAULT_SHUTDOWN_GRACE_MS) {
    throw new Error(
      `${SHUTDOWN_GRACE_ENV_VAR} must be at least ${String(DEFAULT_SHUTDOWN_GRACE_MS)}ms; got ${String(parsed)}. `
      + "Below that the derived watchdog no longer contains a generate's own SIGTERM-plus-recovery sequence "
      + "(5000ms + 2000ms), so a shutdown during a generation would destroy the record of real spend. "
      + "Declare the grace your supervisor actually gives this process, or leave it unset for the documented floor.",
    );
  }
  return deriveShutdownBudget(parsed);
}
