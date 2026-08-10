import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STORAGE_KEY,
  completionFraction,
  describeElapsed,
  describeSections,
  describeTerminal,
  forgetPersistedRun,
  formatDuration,
  JobGoneError,
  JOB_POLL_INTERVAL_MS,
  MAX_CONSECUTIVE_JOB_READ_FAILURES,
  persistRun,
  pollUntilTerminal,
  PollLostContactError,
  PROGRESS_POLL_INTERVAL_MS,
  readDegradedSections,
  restorePersistedRun,
  resumeJob,
  TERMINAL_HEADINGS,
} from "./GenerationProgress";
import { SessionExpiredError } from "../lib/session-fetch";
// Vite's own `?raw` suffix rather than `node:fs` — this workspace's tsconfig
// has no node types, and adding `@types/node` for one test would be a new
// dependency. Same precedent as `App.test.ts` and `ProjectPicker.test.ts`.
import progressSource from "./GenerationProgress.tsx?raw";

/**
 * `.test.ts`, not `.test.tsx` — the repo precedent (`ExportPanel.test.ts`,
 * `LoginScreen.test.ts`, `ProjectPicker.test.ts`) and a measured trap: task 2
 * found `vitest.config.ts` included `src/**\/*.test.ts` ONLY, so a `.test.tsx`
 * file was silently skipped. A test file that exists, reads as coverage and
 * never runs is the one failure perturbation cannot detect, because a test that
 * does not execute cannot fail.
 *
 * Nothing here mounts a component: this workspace has no React testing library
 * and may not add one ("no new runtime dependencies"). That is exactly why the
 * poll loop, the persistence, the `degraded_sections` reader and every piece of
 * wording that can be *dishonest* live outside the component body.
 */

/* ------------------------------------------------------------------ *
 * Harnesses
 * ------------------------------------------------------------------ */

/** An in-memory `Storage`, since vitest runs windowless and there is no real
 *  `localStorage` here. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

/** Every way a real browser's storage can refuse: Safari private mode throws
 *  on `setItem`, and a blocked-cookies policy throws on the property access
 *  itself. */
function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
}

interface Scenario {
  /** One entry per job poll, in order. The last one should be terminal. */
  readonly jobStatuses: readonly string[];
  /** One entry per progress poll, in order: `true` means that read fails. */
  readonly progressErrors?: readonly boolean[];
  /** Extra fields merged into every job response body. */
  readonly jobExtra?: Record<string, unknown>;
}

/**
 * A scripted hosted server. Job reads and progress reads are counted
 * separately, because the whole point of the second test below is that a
 * FAILED progress read must not change what the JOB read is believed to say.
 */
function scriptedBackend(scenario: Scenario) {
  const calls: string[] = [];
  let jobReads = 0;
  let progressReads = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/progress")) {
      const fails = scenario.progressErrors?.[progressReads] ?? false;
      progressReads += 1;
      if (fails) return new Response("upstream is having a moment", { status: 502 });
      return new Response(
        JSON.stringify({
          stage: "generating sections",
          stagesDone: 5,
          stagesTotal: 5,
          sectionsGenerated: progressReads,
          sectionsTotal: 11,
          events: [],
        }),
        { status: 200 },
      );
    }
    const status = scenario.jobStatuses[Math.min(jobReads, scenario.jobStatuses.length - 1)];
    jobReads += 1;
    return new Response(JSON.stringify({ status, ...scenario.jobExtra }), { status: 200 });
  };
  return {
    calls,
    fetchImpl,
    get jobReads() {
      return jobReads;
    },
    get progressReads() {
      return progressReads;
    },
  };
}

/** No real timers anywhere in this file: an ~11-minute flow polled every 3s
 *  would otherwise make the suite unrunnable. */
const immediately = async () => {
  /* no delay */
};

/* ------------------------------------------------------------------ *
 * `interrupted` is NOT a failure
 * ------------------------------------------------------------------ */

describe("describeTerminal: interrupted means UNKNOWN, never failed", () => {
  it("shows `interrupted` as an unknown outcome, never as a failure", () => {
    // The brief's own test. `interrupted` is what a server restart mid-run
    // produces; the server genuinely cannot know whether the child finished,
    // and calling it a failure is the exact lie the state exists to prevent.
    expect(describeTerminal("interrupted")).toMatch(/unknown/i);
    expect(describeTerminal("interrupted")).not.toMatch(/failed/i);
  });

  it("uses no word from the failure family at all for `interrupted`", () => {
    // The discriminating half. `/failed/i` alone still passes for "the run
    // failed to complete" or "failure", so the assertion that names the
    // property has to cover the family, in the heading as well as the body —
    // a heading reading "Generation failed" over an honest paragraph is the
    // same lie, just moved up the page.
    const message = `${TERMINAL_HEADINGS.interrupted} ${describeTerminal("interrupted")}`;
    expect(message).not.toMatch(/fail/i);
    expect(message).not.toMatch(/error/i);
    expect(message).not.toMatch(/broke|crashed|lost/i);
  });

  it("says the outcome is unknown AND that the site may be complete", () => {
    // "Unknown" on its own reads as "probably broken". The actionable half is
    // that the work may well have landed, so the tester checks before paying
    // $1.74 again.
    const message = describeTerminal("interrupted");
    expect(message).toMatch(/unknown/i);
    expect(message).toMatch(/may (be|have)/i);
  });

  it("does call a failed job failed — the honesty runs in both directions", () => {
    // The mirror of the test above: `interrupted` must not be softened into
    // `failed`, and `failed` must not be softened into `interrupted`.
    expect(describeTerminal("failed")).toMatch(/fail/i);
    expect(describeTerminal("failed")).not.toMatch(/unknown/i);
  });

  it("has a distinct heading and body for all three terminal states", () => {
    const all = ["succeeded", "failed", "interrupted"] as const;
    const headings = all.map((s) => TERMINAL_HEADINGS[s]);
    const bodies = all.map((s) => describeTerminal(s));
    expect(new Set(headings).size).toBe(3);
    expect(new Set(bodies).size).toBe(3);
    for (const text of [...headings, ...bodies]) expect(text.trim()).not.toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * The job status is authoritative; progress is advisory
 * ------------------------------------------------------------------ */

describe("pollUntilTerminal: the JOB is authoritative, progress is advisory", () => {
  it("keeps polling through a transient progress error instead of declaring failure", async () => {
    // The brief's own test. A progress read is advisory; the JOB status is
    // authoritative, so a 502 on `/progress` must not become a reported
    // generation failure.
    const states: string[] = [];
    const backend = scriptedBackend({
      jobStatuses: ["running", "running", "succeeded"],
      progressErrors: [true, false, false],
    });
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
      // 0 so a progress read is attempted on every tick, which is what makes
      // the scripted `progressErrors` line up one-to-one with the job polls.
      progressIntervalMs: 0,
      onJob: (job) => states.push(job.status),
    });
    expect(states.at(-1)).toBe("succeeded");
    expect(outcome.status).toBe("succeeded");
  });

  it("still delivers progress AFTER a progress read failed, rather than giving up on it", async () => {
    // The discriminating half of the test above: swallowing the error and then
    // never reading progress again would also pass it, and would leave a
    // tester staring at a frozen stage for eleven minutes.
    const progressUpdates: number[] = [];
    const backend = scriptedBackend({
      jobStatuses: ["running", "running", "succeeded"],
      progressErrors: [true, false, false],
    });
    await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
      progressIntervalMs: 0,
      onProgress: (p) => progressUpdates.push(p.sectionsGenerated),
    });
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(backend.progressReads).toBeGreaterThan(1);
  });

  it("never turns a progress failure into a terminal outcome, whatever the progress endpoint returns", async () => {
    // Every progress read fails, from the first to the last. The job still
    // decides.
    const backend = scriptedBackend({
      jobStatuses: ["queued", "running", "running", "succeeded"],
      progressErrors: [true, true, true, true],
    });
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
      progressIntervalMs: 0,
    });
    expect(outcome.status).toBe("succeeded");
  });

  it("survives a progress read that rejects outright, not merely one that 502s", async () => {
    // A dropped connection rejects the promise; a 502 resolves with a bad
    // response. Handling only the second leaves the first to escape the loop.
    let jobReads = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      if (String(input).includes("/progress")) throw new TypeError("Failed to fetch");
      jobReads += 1;
      return new Response(JSON.stringify({ status: jobReads < 3 ? "running" : "succeeded" }), {
        status: 200,
      });
    };
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl,
      wait: immediately,
      progressIntervalMs: 0,
    });
    expect(outcome.status).toBe("succeeded");
  });

  it("stops reading progress once the job is terminal", async () => {
    // Task 1's endpoint NEVER reports a terminal state — a run log cannot tell
    // "all sections done" from "the process died" — so a progress read made
    // after the outcome is known can only contradict it.
    const backend = scriptedBackend({
      jobStatuses: ["running", "succeeded"],
      progressErrors: [false, false, false],
    });
    await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
      progressIntervalMs: 0,
    });
    expect(backend.calls.at(-1)).toContain("/api/jobs/j1");
    expect(backend.calls.at(-1)).not.toContain("/progress");
  });

  it("reports `interrupted` as a terminal outcome in its own right, not as an error", async () => {
    const backend = scriptedBackend({ jobStatuses: ["running", "interrupted"] });
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
    });
    expect(outcome.status).toBe("interrupted");
  });

  it("carries the job's own result and error through to the caller", async () => {
    // `degraded_sections` lives in `result.stdout`, and a failed job's message
    // lives in `error` — dropping either here makes both invisible downstream.
    const backend = scriptedBackend({
      jobStatuses: ["failed"],
      jobExtra: { error: "orchestrator exited with code 1: boom", result: { stdout: "x" } },
    });
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: immediately,
    });
    expect(outcome.error).toBe("orchestrator exited with code 1: boom");
    expect(outcome.result).toEqual({ stdout: "x" });
  });

  it("polls the job on its own interval, defaulting to 3s, and progress to 5s", () => {
    // Named constants rather than magic numbers scattered through the loop, so
    // the cadence the brief specifies is one edit away from being audited.
    expect(JOB_POLL_INTERVAL_MS).toBe(3000);
    expect(PROGRESS_POLL_INTERVAL_MS).toBe(5000);
  });

  it("waits between polls rather than spinning the CPU on a queued job", async () => {
    const waits: number[] = [];
    const backend = scriptedBackend({ jobStatuses: ["queued", "running", "succeeded"] });
    await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits.length).toBe(2);
    for (const ms of waits) expect(ms).toBe(JOB_POLL_INTERVAL_MS);
  });

  it("reads progress at its own, slower cadence rather than on every job poll", async () => {
    // The default cadence is real: at 3s/5s a run polls progress roughly every
    // other tick. Driven by an injected clock so this asserts the RULE, not a
    // wall-clock coincidence.
    let clock = 0;
    const backend = scriptedBackend({
      jobStatuses: ["running", "running", "running", "running", "succeeded"],
    });
    await pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    });
    // 4 non-terminal ticks at t=0,3s,6s,9s: progress is read at 0, 6s and 9s
    // (5s having elapsed since the previous read), never four times.
    expect(backend.progressReads).toBeLessThan(4);
    expect(backend.progressReads).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * A 401 is its own state; a vanished job must not strand the UI
 * ------------------------------------------------------------------ */

describe("pollUntilTerminal: the failures that are NOT generation failures", () => {
  it("raises a session expiry as its own error, never as a failed generation", async () => {
    // Reporting "generation failed" for a session that merely lapsed is the
    // same lie `interrupted` exists to prevent, and the autosave path shipped
    // exactly that bug once already.
    const fetchImpl = async () => new Response(JSON.stringify({ error: "x" }), { status: 401 });
    await expect(pollUntilTerminal({ jobId: "j1", fetchImpl, wait: immediately })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("raises a vanished job as its own error, so a stale entry cannot strand the UI", async () => {
    // `GET /api/jobs/:id` answers 404 for a foreign job and an absent one
    // identically. A persisted run id from a wiped database, or from another
    // account on the same machine, must return the tester to the picker — not
    // spin forever on a job nobody has.
    const fetchImpl = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    await expect(pollUntilTerminal({ jobId: "j1", fetchImpl, wait: immediately })).rejects.toBeInstanceOf(
      JobGoneError,
    );
  });

  it("rides out a transient job-read failure instead of reporting one", async () => {
    // A server restart is exactly what produces `interrupted`, and the job
    // endpoint is unreachable while it happens. Giving up on the first 502
    // would mean a tester never sees the state the brief says they WILL hit.
    let reads = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      if (String(input).includes("/progress")) return new Response("{}", { status: 502 });
      reads += 1;
      if (reads <= 3) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ status: "interrupted" }), { status: 200 });
    };
    const seen: number[] = [];
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl,
      wait: immediately,
      onConnectionTrouble: (consecutive) => seen.push(consecutive),
    });
    expect(outcome.status).toBe("interrupted");
    expect(seen).toEqual([1, 2, 3]);
  });

  it("gives up eventually rather than polling a dead server forever, and says so as lost contact", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      pollUntilTerminal({ jobId: "j1", fetchImpl, wait: immediately, maxConsecutiveJobErrors: 3 }),
    ).rejects.toBeInstanceOf(PollLostContactError);
  });

  it("defaults its patience to a bounded, named number of consecutive failures", () => {
    expect(MAX_CONSECUTIVE_JOB_READ_FAILURES).toBeGreaterThan(1);
    expect(Number.isFinite(MAX_CONSECUTIVE_JOB_READ_FAILURES)).toBe(true);
  });

  it("resets its patience after a single successful read", async () => {
    // Otherwise a long run with intermittent blips exhausts the budget and
    // reports lost contact while the server is plainly answering.
    let reads = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      if (String(input).includes("/progress")) return new Response("{}", { status: 502 });
      reads += 1;
      // fail, ok, fail, ok, fail, ok, ... then terminal
      if (reads >= 9) return new Response(JSON.stringify({ status: "succeeded" }), { status: 200 });
      if (reads % 2 === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    };
    const outcome = await pollUntilTerminal({
      jobId: "j1",
      fetchImpl,
      wait: immediately,
      maxConsecutiveJobErrors: 2,
    });
    expect(outcome.status).toBe("succeeded");
  });

  it("refuses a 200 whose status is not a job status at all", async () => {
    // A proxy that swallowed the request, or a future status this build does
    // not know, must not fall out of the loop as a fabricated terminal
    // outcome — the defect `lib/jobs.ts` was fixed for.
    const fetchImpl = async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 });
    await expect(
      pollUntilTerminal({ jobId: "j1", fetchImpl, wait: immediately, maxConsecutiveJobErrors: 2 }),
    ).rejects.toBeInstanceOf(PollLostContactError);
  });

  it("stops when the caller says it has gone away, without one more request", async () => {
    // The component unmounts when the tester signs out or the outcome is
    // acted on; a loop that keeps polling then leaks a request every 3s.
    const backend = scriptedBackend({ jobStatuses: ["running", "running", "succeeded"] });
    let cancelled = false;
    const outcome = pollUntilTerminal({
      jobId: "j1",
      fetchImpl: backend.fetchImpl,
      wait: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    await expect(outcome).rejects.toThrow(/cancelled/i);
    expect(backend.jobReads).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * A run must survive a reload — this is the MONEY requirement
 * ------------------------------------------------------------------ */

describe("persistence: a run outlives the tab, because a second one costs $1.74", () => {
  it("round-trips a started generation through storage", () => {
    // Without this, reloading mid-run returns the tester to the picker with a
    // real run still going. They conclude it failed and press Generate again:
    // $1.74 each, and the per-user bound is 2, so the second one SUCCEEDS.
    const storage = memoryStorage();
    persistRun(storage, { jobId: "j1", projectId: "p1" });
    expect(restorePersistedRun(storage)).toEqual({ jobId: "j1", projectId: "p1" });
  });

  it("stores both ids, because they name different things", () => {
    const storage = memoryStorage();
    persistRun(storage, { jobId: "j1", projectId: "p1" });
    const raw = storage.getItem(ACTIVE_RUN_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ jobId: "j1", projectId: "p1" });
  });

  it("forgets a run once it is over", () => {
    const storage = memoryStorage();
    persistRun(storage, { jobId: "j1", projectId: "p1" });
    forgetPersistedRun(storage);
    expect(restorePersistedRun(storage)).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing at mount", () => {
    // This value is read during App's own `useState` initializer. A throw
    // there takes the entire hosted shell down before anything renders — a
    // white screen, with no way to reach the picker and clear it.
    const storage = memoryStorage({ [ACTIVE_RUN_STORAGE_KEY]: "{not json" });
    expect(restorePersistedRun(storage)).toBeNull();
  });

  it("returns null for a half-written entry rather than a partial run", () => {
    for (const value of [
      JSON.stringify({ jobId: "j1" }),
      JSON.stringify({ projectId: "p1" }),
      JSON.stringify({ jobId: 7, projectId: "p1" }),
      JSON.stringify({ jobId: "", projectId: "p1" }),
      JSON.stringify(["j1", "p1"]),
      JSON.stringify(null),
      JSON.stringify("j1"),
    ]) {
      const storage = memoryStorage({ [ACTIVE_RUN_STORAGE_KEY]: value });
      expect(restorePersistedRun(storage), value).toBeNull();
    }
  });

  it("never throws when storage itself is unavailable", () => {
    // Safari private browsing throws on `setItem`; a blocked-cookies policy
    // throws on the property access. Neither is a reason to lose the screen.
    const storage = throwingStorage();
    expect(() => persistRun(storage, { jobId: "j1", projectId: "p1" })).not.toThrow();
    expect(restorePersistedRun(storage)).toBeNull();
    expect(() => forgetPersistedRun(storage)).not.toThrow();
    expect(restorePersistedRun(null)).toBeNull();
    expect(() => persistRun(null, { jobId: "j1", projectId: "p1" })).not.toThrow();
    expect(() => forgetPersistedRun(null)).not.toThrow();
  });

  it("stores no API key material, no email, and nothing but the two ids", () => {
    const storage = memoryStorage();
    persistRun(storage, { jobId: "j1", projectId: "p1" });
    expect(Object.keys(JSON.parse(storage.getItem(ACTIVE_RUN_STORAGE_KEY) as string) as object).sort()).toEqual([
      "jobId",
      "projectId",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * degraded_sections — buried in result.stdout, read by nothing until now
 * ------------------------------------------------------------------ */

/** Shaped exactly like a real run's stdout: the orchestrator prints progress
 *  lines BEFORE the final `json.dumps(result, indent=2)` (fanout.py's own
 *  `=== ...` lines, each pipeline's `exec_id: ...`), so the captured stdout is
 *  NOT parseable as JSON on its own. */
function realStdout(degraded: readonly string[]): string {
  return [
    "exec_id: 0198f2b1-plan",
    "exec_id: 0198f2b1-design",
    "=== fan-out: spawning 3 page workers in parallel: ['home', 'about', 'pricing']",
    "=== home: exit=0 duration=180.2s",
    "{",
    '  "run_id": "web-2578801a-9d5a-4461-90eb-4a771fde5648",',
    '  "routes": [',
    '    "home",',
    '    "about"',
    "  ],",
    `  "degraded_sections": [${degraded.map((s) => `\n    ${JSON.stringify(s)}`).join(",")}${degraded.length > 0 ? "\n  " : ""}],`,
    '  "timings_s": {',
    '    "total": 676.8',
    "  }",
    "}",
  ].join("\n");
}

describe("readDegradedSections: the section that shipped as a grey placeholder box", () => {
  it("names a section that exhausted its retries", () => {
    // Measured on a real run: `home.community-values`, 3 attempts, all failed.
    // It ships as a visible `<FailedSectionPlaceholder />` — valid code that
    // passes every gate — so the page renders with a grey box and the job is
    // `succeeded`. A tester who meets that with no explanation files a bug.
    const reading = readDegradedSections({ stdout: realStdout(["home.community-values"]) });
    expect(reading).toEqual({ kind: "some", sections: ["home.community-values"] });
  });

  it("distinguishes 'none were degraded' from 'could not tell'", () => {
    // The discriminating half. Returning `[]` for both would make a truncated
    // or unreadable summary claim a clean run, which is the same class of lie
    // as reporting `interrupted` as failed.
    expect(readDegradedSections({ stdout: realStdout([]) })).toEqual({ kind: "none" });
    expect(readDegradedSections({ stdout: "no summary here" })).toEqual({ kind: "unknown" });
    expect(readDegradedSections(undefined)).toEqual({ kind: "unknown" });
    expect(readDegradedSections({})).toEqual({ kind: "unknown" });
    expect(readDegradedSections({ stdout: 42 })).toEqual({ kind: "unknown" });
  });

  it("reads a summary whose FRONT was cut off, because the server keeps only the last 4000 chars", () => {
    // `job-worker.ts` stores `JSON.stringify({ stdout: safeStdout.slice(-4000) })`.
    // A whole-document `JSON.parse` therefore cannot be the only strategy: the
    // captured text routinely starts mid-object.
    const full = realStdout(["about.team", "pricing.faq"]);
    const truncated = full.slice(-Math.floor(full.length / 2));
    expect(readDegradedSections({ stdout: truncated })).toEqual({
      kind: "some",
      sections: ["about.team", "pricing.faq"],
    });
  });

  it("reads the field even when the whole document IS valid JSON", () => {
    // The other direction: `publicJobView` parses `result_json`, so a caller
    // can legitimately hand this a plain object too.
    const stdout = JSON.stringify({ degraded_sections: ["home.hero"], routes: ["home"] });
    expect(readDegradedSections({ stdout })).toEqual({ kind: "some", sections: ["home.hero"] });
  });

  it("accepts a raw string result, since publicJobView falls back to one on a parse failure", () => {
    expect(readDegradedSections(realStdout(["home.hero"]))).toEqual({
      kind: "some",
      sections: ["home.hero"],
    });
  });

  it("reads the LAST occurrence, so a brief that mentions the field cannot spoof it", () => {
    // The brief becomes the project name and can contain anything; the run
    // summary is always last.
    const stdout = `"degraded_sections": ["not-real"]\n${realStdout(["home.hero"])}`;
    expect(readDegradedSections({ stdout })).toEqual({ kind: "some", sections: ["home.hero"] });
  });

  it("degrades to `unknown` on every malformed shape rather than throwing", () => {
    for (const stdout of [
      '"degraded_sections":',
      '"degraded_sections": [',
      '"degraded_sections": ["unterminated',
      '"degraded_sections": {"not": "an array"}',
      '"degraded_sections": [nonsense]',
    ]) {
      expect(readDegradedSections({ stdout }), stdout).toEqual({ kind: "unknown" });
    }
  });

  it("drops non-string entries rather than rendering `[object Object]` at a tester", () => {
    const stdout = '"degraded_sections": ["home.hero", 7, null, {"a":1}, "about.team"]';
    expect(readDegradedSections({ stdout })).toEqual({
      kind: "some",
      sections: ["home.hero", "about.team"],
    });
  });
});

/* ------------------------------------------------------------------ *
 * Honest numbers
 * ------------------------------------------------------------------ */

describe("formatDuration / describeElapsed: an honest clock against an honest expectation", () => {
  it("formats seconds and minutes the way a person reads them", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(676_800)).toBe("11m 16s");
  });

  it("never renders a negative or nonsense clock", () => {
    // The elapsed baseline is the SERVER's `createdAt` against the BROWSER's
    // clock. The two are not the same clock, and a skewed one must not produce
    // "-4m 12s elapsed".
    expect(formatDuration(-5000)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });

  it("states the measured expectation, and stops claiming it once it is passed", () => {
    // ~11 minutes is measured (676.8s on the live control run), not estimated.
    expect(describeElapsed(60_000)).toBe("1m 0s elapsed, of about 11 minutes.");
    expect(describeElapsed(20 * 60_000)).toBe(
      "20m 0s elapsed — longer than the ~11 minutes a measured run took. Runs vary; this one is still going.",
    );
  });
});

describe("describeSections: sectionsGenerated CAN exceed sectionsTotal", () => {
  it("renders a plain count while the plan's total is still unknown", () => {
    // `sectionsTotal` is null until `plan.complete` lands.
    expect(describeSections(0, null)).toBe("0 sections generated");
    expect(describeSections(1, null)).toBe("1 section generated");
    expect(describeSections(4, null)).toBe("4 sections generated");
  });

  it("renders a ratio when the plan's total is known", () => {
    expect(describeSections(3, 11)).toBe("3 of 11 sections generated");
    expect(describeSections(11, 11)).toBe("11 of 11 sections generated");
  });

  it("does not pretend 12 of 11 is impossible — it was MEASURED", () => {
    // A real run generated 12 distinct sections against a plan of 11, the plan
    // having been revised after `plan.complete` was logged. "12 of 11" reads
    // as a bug in the UI; naming the discrepancy reads as the truth.
    expect(describeSections(12, 11)).toBe("12 sections generated (the plan listed 11)");
  });

  it("clamps the bar rather than overflowing it, and never computes a negative remainder", () => {
    expect(completionFraction(3, 11)).toBeCloseTo(3 / 11);
    expect(completionFraction(12, 11)).toBe(1);
    expect(completionFraction(-1, 11)).toBe(0);
    expect(completionFraction(3, null)).toBeNull();
    expect(completionFraction(3, 0)).toBeNull();
    expect(completionFraction(0, 5)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

describe("resumeJob: a failed job can be retried from where it stopped", () => {
  it("returns the NEW job id, because a resume is a new job row", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ jobId: "j2" }), { status: 202 });
    await expect(resumeJob("j1", { fetchImpl })).resolves.toBe("j2");
  });

  it("POSTs to the resume path for the job it was given", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ jobId: "j2" }), { status: 202 });
    };
    await resumeJob("j1", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/jobs/j1/resume");
  });

  it("surfaces a 409 in the server's own words, because they name the fix", async () => {
    // A resume is refused 409 when the server's `code_version` no longer
    // matches the one the job ran under — Kitaru keys its cache on function
    // code plus args, so a changed checkpoint re-executes while a paired one
    // silently skips its side effect. The server already words this, and the
    // fix it names ("start a fresh job") is the whole message.
    const message =
      "the server code has changed since this job ran; it cannot be resumed — start a fresh job instead";
    const fetchImpl = async () => new Response(JSON.stringify({ error: message }), { status: 409 });
    await expect(resumeJob("j1", { fetchImpl })).rejects.toThrow(message);
  });

  it("treats a session expiry as its own state here too", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "x" }), { status: 401 });
    await expect(resumeJob("j1", { fetchImpl })).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("refuses to believe any status other than 202 started a new job", async () => {
    // The same discrimination rule `startGeneration` and `lib/jobs.ts` use:
    // 202 is the one signal reserved for "a job now exists, go poll for it".
    const fetchImpl = async () => new Response(JSON.stringify({ jobId: "j2" }), { status: 200 });
    await expect(resumeJob("j1", { fetchImpl })).rejects.toThrow(/HTTP 200/);
  });

  it("rejects a 202 that names no job, rather than polling `/api/jobs/undefined`", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 202 });
    await expect(resumeJob("j1", { fetchImpl })).rejects.toThrow(/did not say which job/i);
  });
});

/* ------------------------------------------------------------------ *
 * The component's own wiring — source text, for the reason App.test.ts gives
 * ------------------------------------------------------------------ */

describe("GenerationProgress.tsx: the wiring a library test structurally cannot reach", () => {
  it("renders every terminal state through describeTerminal, never a literal", () => {
    // A literal "Generation failed" in the JSX would be invisible to every
    // test above, which is exactly how `interrupted` would get reported as a
    // failure again.
    expect(progressSource).toContain("describeTerminal(");
    expect(progressSource).toContain("TERMINAL_HEADINGS[");
  });

  it("forgets the persisted run once the job is terminal, so a reload cannot re-enter a finished run", () => {
    expect(progressSource).toContain("forgetPersistedRun(");
  });

  it("offers no way back to the Generate button while the run is still going", () => {
    // Task 3's two deliberate omissions, preserved: no "open project" (the
    // project exists with an EMPTY directory for ~11 minutes) and no "back to
    // list" (it re-exposes a button that spends $1.74). Both become available
    // once the run is over, which is a different screen.
    const running = progressSource.slice(
      progressSource.indexOf('data-testid="generation-running"'),
      progressSource.indexOf('data-testid="generation-terminal"'),
    );
    expect(running.length).toBeGreaterThan(0);
    expect(running).not.toContain("onDone(");
    expect(running).not.toContain("onAbandon(");
  });

  it("states plainly that there is no cancellation", () => {
    // Spec decision 13: the orchestrator subprocess cannot be safely killed,
    // so spend continues regardless. A tester who is not told finds out by
    // paying.
    expect(progressSource).toMatch(/cannot be cancelled/i);
  });
});
