// server/src/shutdown-budget.test.ts
/**
 * The ordering `proxiedWaitMs < watchdogMs < graceMs` is the whole contract.
 *
 * Its inverse is a real defect that shipped once on this branch: with a 25s
 * proxied wait and an 8s watchdog, the watchdog killed the preview child the
 * waiting job depended on, so the wait could never pay off under ANY grace —
 * ~40 lines of machinery that provably could not fire. These tests fail if that
 * relationship inverts again, at any grace, rather than only at the default.
 */
import { describe, expect, it } from "vitest";
import {
  CLEANUP_RESERVE_MS, DEFAULT_SHUTDOWN_GRACE_MS, deriveShutdownBudget, loadShutdownBudget,
  SHUTDOWN_GRACE_ENV_VAR, WAIT_RESERVE_MS,
} from "./shutdown-budget.ts";
import { SHUTDOWN_KILL_GRACE_MS, SHUTDOWN_WAIT_MS } from "./job-worker.ts";

describe("deriveShutdownBudget", () => {
  it("preserves proxiedWait < watchdog < grace at every grace an operator can declare", () => {
    // A property, not three spot checks: an arithmetic change that happens to
    // keep the default valid while breaking a 30s or 120s deployment is
    // exactly the shape of regression this catches.
    for (const graceMs of [10_000, 12_000, 15_000, 30_000, 45_000, 60_000, 120_000, 600_000]) {
      const budget = deriveShutdownBudget(graceMs);
      expect(budget.graceMs).toBe(graceMs);
      expect(budget.proxiedWaitMs).toBeLessThan(budget.watchdogMs);
      expect(budget.watchdogMs).toBeLessThan(budget.graceMs);
      expect(budget.proxiedWaitMs).toBeGreaterThan(0);
    }
  });

  it("leaves a generate's whole SIGTERM-plus-recovery sequence inside the watchdog at every grace", () => {
    // That sequence is what puts ~$1-2 of real spend into `usage_event`
    // instead of leaving it for the next boot's sweeper. A watchdog that fires
    // during it recreates the money-loss bug the bounded stop() fixed.
    for (const graceMs of [10_000, 30_000, 120_000]) {
      expect(SHUTDOWN_WAIT_MS + SHUTDOWN_KILL_GRACE_MS)
        .toBeLessThanOrEqual(deriveShutdownBudget(graceMs).watchdogMs);
    }
  });

  it("reserves real time for the kills and for the wait to unwind, not zero", () => {
    const budget = deriveShutdownBudget(30_000);
    expect(budget.graceMs - budget.watchdogMs).toBe(CLEANUP_RESERVE_MS);
    expect(budget.watchdogMs - budget.proxiedWaitMs).toBe(WAIT_RESERVE_MS);
  });

  it("gives a 30s deployment the window the differentiated wait was chosen for", () => {
    // The case the whole feature exists for: a regen already partway through a
    // ~27s run finishes, and cleanup still lands inside the grace.
    expect(deriveShutdownBudget(30_000)).toEqual({ graceMs: 30_000, watchdogMs: 28_000, proxiedWaitMs: 25_000 });
  });

  it("refuses a grace too small to produce a valid ordering rather than returning a nonsense one", () => {
    expect(() => deriveShutdownBudget(5_000)).toThrow(/cannot produce a valid ordering/);
  });
});

describe("loadShutdownBudget", () => {
  it("defaults to the documented floor when the variable is unset or blank", () => {
    const expected = deriveShutdownBudget(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(loadShutdownBudget({})).toEqual(expected);
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "   " })).toEqual(expected);
    // The default must be exactly today's safe behaviour: cleanup well inside
    // a 10s grace, nothing regressed for an operator who sets nothing.
    expect(expected.watchdogMs).toBe(8_000);
  });

  it("derives every deadline from a declared grace", () => {
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "30000" }))
      .toEqual({ graceMs: 30_000, watchdogMs: 28_000, proxiedWaitMs: 25_000 });
    // Surrounding whitespace is an ordinary shell accident, not a typo worth
    // refusing a boot over.
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: " 30000 " }).graceMs).toBe(30_000);
  });

  for (const [name, value] of [
    ["a unit suffix", "30s"],
    // The one that actually discriminates `Number` from `parseInt`: "30s"
    // alone does NOT, because parseInt reads it as 30, which the floor check
    // then refuses anyway — for the wrong reason, but it refuses. parseInt
    // reads THIS as 10000 and accepts it as a 10-second grace, when the
    // operator wrote 10000 SECONDS: a silent 1000x misreading. Number gives
    // NaN and refuses.
    ["a unit suffix that survives truncation", "10000s"],
    ["a bare word", "thirty"],
    ["a float", "30000.5"],
    ["a negative", "-30000"],
    ["Infinity", "Infinity"],
    ["an empty-ish garbage value", "--"],
  ] as const) {
    it(`refuses ${name} loudly instead of silently falling back to the floor`, () => {
      // Silently defaulting is the failure mode this exists to prevent: the
      // operator believes they declared 30s, the process runs on 10s, and the
      // consequence (an orphaned child, or a job killed partway) surfaces
      // minutes later somewhere else. `Number` and not `parseInt` is what
      // catches "30s" — parseInt would read it as 30 and be wrong by three
      // orders of magnitude.
      expect(() => loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: value }))
        .toThrow(new RegExp(SHUTDOWN_GRACE_ENV_VAR));
    });
  }

  it("accepts JavaScript's other integer spellings, because Number reads them CORRECTLY", () => {
    // Written down rather than left as an accident of using `Number`: `0x7530`
    // and `3e4` both mean exactly 30000 and are parsed as 30000, so neither is
    // the misreading hazard the validation exists for (that hazard is
    // `parseInt("30s") === 30` — wrong by three orders of magnitude, and
    // rejected above). Found by a perturbation test of my own that asserted hex
    // was refused and turned out to be asserting the wrong thing.
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "0x7530" }).graceMs).toBe(30_000);
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "3e4" }).graceMs).toBe(30_000);
  });

  it("refuses a grace below the floor, naming the sequence that would no longer fit", () => {
    // 9000 derives a 7000ms watchdog — exactly SHUTDOWN_WAIT_MS +
    // SHUTDOWN_KILL_GRACE_MS, leaving no room at all — and anything smaller
    // cuts a generate's spend recovery short.
    expect(() => loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "9000" }))
      .toThrow(/at least 10000ms/);
    expect(() => loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: "0" })).toThrow(/at least 10000ms/);
  });

  it("accepts exactly the floor", () => {
    expect(loadShutdownBudget({ [SHUTDOWN_GRACE_ENV_VAR]: String(DEFAULT_SHUTDOWN_GRACE_MS) }).graceMs)
      .toBe(DEFAULT_SHUTDOWN_GRACE_MS);
  });
});
