/**
 * The screen a tester stares at for ~11 minutes while a generation runs on
 * their own money.
 *
 * It replaces the placeholder task 3 left in `App.tsx`'s hosted-shell branch,
 * and it is HOSTED MODE ONLY for the same reason `LoginScreen` and
 * `ProjectPicker` are: the local, unauthenticated preview server has no
 * session, no job table and no worker. Local mode must keep behaving exactly
 * as it does today.
 *
 * EVERYTHING THAT CAN BE DISHONEST LIVES OUTSIDE THE COMPONENT. This workspace
 * has no React testing library and may not add one ("no new runtime
 * dependencies"), so a function inside the component body is untestable by
 * construction — the same reasoning that produced `session-fetch.ts`,
 * `submitLogin` and `startGeneration`. What is pulled out here is precisely
 * the set of things that can lie to a user about money or about outcomes: the
 * poll loop's authority rules, the wording of each terminal state, the
 * persistence that keeps a run alive across a reload, and the reader that digs
 * `degraded_sections` out of a job result.
 *
 * FIVE PROPERTIES ARE LOAD-BEARING, and each one is easy to break by accident:
 *
 * 1. **A run survives a reload, and that is a MONEY requirement.** Before this,
 *    `startedGeneration` lived only in tab state: reloading mid-run returned
 *    the tester to the picker with a real run still going. They conclude it
 *    failed and press Generate again — **$1.74 each, and the per-user bound is
 *    2, so the second one succeeds.** The pair `{jobId, projectId}` is
 *    persisted (localStorage; no server change needed) and re-read on mount.
 *
 * 2. **`interrupted` means the outcome is UNKNOWN, never "failed."** It is what
 *    a server restart mid-run produces, and the server genuinely cannot know
 *    whether the child finished — a subprocess killed mid-`write_section_only`
 *    may have left a half-written page. A tester WILL hit this (every deploy,
 *    every Ctrl-C). Reporting it as a failure is the exact lie the state exists
 *    to prevent.
 *
 * 3. **The job status is authoritative; progress is advisory.** Task 1's
 *    `/progress` endpoint deliberately NEVER reports a terminal state — a run
 *    log cannot tell "all sections done" from "the process died after the last
 *    section." So the outcome comes from `GET /api/jobs/:id` and from nothing
 *    else, a failed progress read is swallowed, and progress stops being read
 *    at all once the job is terminal.
 *
 * 4. **`degraded_sections` is surfaced.** A section that fails its gates on all
 *    3 attempts ships as a visible `<FailedSectionPlaceholder />` — valid code
 *    that passes every gate — so the run legitimately `succeeded` with a grey
 *    box on the page. This happened on a real measured run
 *    (`home.community-values`, 3 attempts, all failed). The orchestrator
 *    reports it correctly, but the value is buried in `result.stdout` as JSON
 *    and nothing read it. A tester who meets that box with no explanation files
 *    it as a bug.
 *
 * 5. **There is no cancellation, and it is stated.** Spec decision 13: the
 *    orchestrator subprocess cannot be safely killed, so spend continues
 *    regardless of what this screen does.
 */
import { useEffect, useRef, useState } from "react";
import { jobProgressUrl, jobResumeUrl, jobUrl } from "../lib/backend";
import type { PollingJobStatus, TerminalJobStatus } from "../lib/jobs";
import { SessionExpiredError } from "../lib/session-fetch";
import type { StartedGeneration } from "./ProjectPicker";

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

/** The subset of `publicJobView` this screen reads. Deliberately not the whole
 *  thing: `kind` is always `"generate"` here, and `projectId` is already known
 *  by the caller that started the run. */
export interface JobView {
  readonly status: PollingJobStatus | TerminalJobStatus;
  readonly result?: unknown;
  readonly error?: string;
  /** Server-side ms epochs. Used only as an elapsed-time baseline, and only
   *  when they are plausible — see `baselineFor`. */
  readonly createdAt?: number;
  readonly startedAt?: number | null;
  readonly finishedAt?: number | null;
}

/** Task 1's `GET /api/jobs/:id/progress`, minus `events` (a timeline this
 *  screen has no room for and no use for — the DAG report already owns it). */
export interface ProgressView {
  readonly stage: string;
  readonly stagesDone: number;
  readonly stagesTotal: number;
  readonly sectionsGenerated: number;
  readonly sectionsTotal: number | null;
}

export interface RequestOptions {
  /** Test seam only; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------------ *
 * The three terminal states, worded
 * ------------------------------------------------------------------ */

/**
 * Headings and bodies for the three states a job can finish in.
 *
 * `interrupted` is the one that matters most and the one most likely to be
 * "helpfully" collapsed into `failed` by a later edit. Note that neither its
 * heading nor its body contains any word from the failure family — a heading
 * reading "Generation failed" over an honest paragraph is the same lie, just
 * moved up the page, and a test asserts the whole message is clean.
 */
export const TERMINAL_HEADINGS: Readonly<Record<TerminalJobStatus, string>> = {
  succeeded: "Your site is ready",
  failed: "The generation failed",
  interrupted: "The outcome is unknown",
};

const TERMINAL_BODIES: Readonly<Record<TerminalJobStatus, string>> = {
  succeeded:
    "The pipeline ran to the end: the plan, the design system, the app shell and every section, then a full export with typecheck, gates and a production build.",
  failed:
    "The generation failed before it finished. The server's own message is below. You can resume from the step it failed on, or start again from a fresh brief.",
  // No "fail", no "error", no "crashed", no "lost" — see this constant's own
  // comment. The word "unknown" is in the BODY and not only the heading,
  // because the body is what a caller reads on its own. The second sentence is
  // the actionable half: "unknown" alone reads as "probably broken", which is
  // what sends a tester back to Generate for another $1.74.
  interrupted:
    "The server restarted while this run was going, so its outcome is unknown — nobody can say what happened to it. The site may be complete, partly written, or untouched. Open your list of sites and look before spending again.",
};

/** The body text for a terminal status. Exported (and used by the JSX rather
 *  than a literal) so the wording is testable at all. */
export function describeTerminal(status: TerminalJobStatus): string {
  return TERMINAL_BODIES[status];
}

/* ------------------------------------------------------------------ *
 * DOGFOOD G6 — the expected, free, self-healing first-run failure
 * ------------------------------------------------------------------ */

/**
 * The marker Kitaru's own refusal always carries
 * (`kitaru/flow.py`'s `_fail_closed_on_stale_active_stack`).
 *
 * WHY THIS SCREEN RECOGNISES ONE FAILURE BY TEXT AT ALL. A freshly created
 * container's FIRST generation always fails at about 13 seconds having spent
 * **$0.00**: `orchestrator/.kitaru/` is gitignored host state carried in by the
 * bind mount, so a stack id written on the host reaches a container whose own
 * Kitaru database was created fresh and does not have it. Kitaru refuses rather
 * than silently running on a different stack, rewrites the config through the
 * mount, and the next submission works. The README documents this as expected;
 * the screen said none of it. What a tester met instead was "The generation
 * failed" over ~30 lines of raw subprocess output (Kitaru's stale-stack
 * reasoning plus `uv` noise like `Bytecode compiled 6239 files in 889ms`), with
 * no statement that nothing was charged, and with **"Resume from where it
 * stopped" as the primary button** while the documented fix is to submit the
 * brief again.
 *
 * Matched on the refusal's own sentence rather than on an exit code or a stage
 * name, because that sentence is the only thing that identifies THIS failure
 * (the stage is `plan`, which every early failure shares, and the exit code is
 * 1, which every failure shares). Kitaru is a dependency, so the string can
 * change under us — the failure mode of a miss is today's behaviour, i.e. the
 * ordinary failed screen, which is why this is safe to key on text.
 */
export const STALE_STACK_MARKER = "active stack appears stale";

/**
 * The FIRST stage `acceptance.py` can fail in (`generate_site` runs
 * plan -> approve -> design -> shell -> fanout -> export, and its `StageError`
 * names the stage). Failing here means nothing downstream ran.
 */
export const FIRST_PIPELINE_STAGE = "plan";

/**
 * The stage named by `server/src/orchestrator-failure.ts`'s rendered report
 * (`failed stage: <stage>` is line 2 of a failed generate's `error`), or
 * `undefined` when there is no report to read — a container OOM kill, a missing
 * interpreter, or an older server.
 *
 * Anchored to the start of a line so a stage name quoted inside a raw stream
 * tail further down the same message cannot be mistaken for the verdict.
 */
export function failedStageOf(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  return /^failed stage: *(\S+)/m.exec(error)?.[1];
}

/**
 * A failure this screen can explain instead of merely printing.
 *
 * `spentNothing` is the field that must never be wrong: it is a claim about the
 * user's money. It is true only when the refusal is provably before the first
 * model call — the marker present AND the failed stage being the first one. A
 * stale-stack refusal reported at any later stage means the stages before it had
 * already run and were billed, and a refusal with no readable stage means this
 * app does not know, so neither may claim $0.00.
 */
export interface KnownFailure {
  readonly kind: "kitaru-stale-stack";
  readonly stage: string | undefined;
  readonly spentNothing: boolean;
  readonly heading: string;
  /** The label for the PRIMARY action, which for this failure is not Resume. */
  readonly primaryLabel: string;
}

/** No word from the crash family, deliberately: this outcome is documented,
 *  expected, free and self-healing, and reading as a crash is the whole defect. */
export const STALE_STACK_HEADING = "This first run stopped — expected in a fresh container";

/** The primary action, in the words of the README's own remedy ("Submit the
 *  brief again and it works"). */
export const SUBMIT_AGAIN_LABEL = "Submit the brief again";

export function recogniseKnownFailure(error: string | undefined): KnownFailure | null {
  if (error === undefined || !error.includes(STALE_STACK_MARKER)) return null;
  const stage = failedStageOf(error);
  return {
    kind: "kitaru-stale-stack",
    stage,
    spentNothing: stage === FIRST_PIPELINE_STAGE,
    heading: STALE_STACK_HEADING,
    primaryLabel: SUBMIT_AGAIN_LABEL,
  };
}

/**
 * The body for a recognised failure: what happened, what it cost, and what to do
 * — in that order, because the cost is the fact the tester most needs and the
 * one the screen never mentioned.
 *
 * The money sentence has three forms and no default. Verified: the dogfood run's
 * first generation recorded **zero** `usage_event` rows and the CLI reported
 * `$0.00 spent`, which is what licenses the $0.00 claim for a `plan`-stage
 * refusal — and what forbids it anywhere else.
 */
export function describeKnownFailure(failure: KnownFailure): string {
  const what =
    "Kitaru refused to start the pipeline because its saved active stack was stale. This is the known first-run failure in a freshly created container, not a fault in your brief or your key: Kitaru has already rewritten its own config, and submitting the same brief again gets past it.";
  if (failure.spentNothing) {
    return `${what} It stopped before any model was called, so this attempt cost $0.00 — no calls were billed to your key and your daily budget is untouched.`;
  }
  if (failure.stage === undefined) {
    return `${what} This page cannot tell from the message how far the run got, so check the budget line on your sites page before submitting again.`;
  }
  return `${what} It stopped at the ${failure.stage} stage rather than at the start, so the stages before it did run and were billed — check the budget line on your sites page before submitting again.`;
}

/** Where `server/src/orchestrator-failure.ts` stops explaining and starts
 *  quoting: every raw stream tail it appends is introduced by this. */
const RAW_TAIL_MARKER = "\n--- raw ";

/**
 * Splits a failed generate's `error` into the part that says what broke and the
 * raw stream tails below it.
 *
 * Wave 1 built that message specifically so "a reader who stops after three
 * lines has the stage; a reader who needs bytes has them below" — but the screen
 * rendered the whole thing as one wall of red, so the reader stopped at
 * `Bytecode compiled 6239 files in 889ms`. The summary is shown; the tails go
 * behind a disclosure that says what it holds. Nothing is discarded, and a
 * message with no marker at all (an older server, a non-generate failure) comes
 * back whole with `raw: undefined`, which renders exactly as it does today.
 */
export function splitFailureMessage(error: string): { summary: string; raw: string | undefined } {
  const at = error.indexOf(RAW_TAIL_MARKER);
  if (at === -1) return { summary: error, raw: undefined };
  const summary = error.slice(0, at).trim();
  const raw = error.slice(at + 1);
  // A message that is nothing BUT tails (no exit-code header, no report) must
  // not render an empty summary over a collapsed disclosure — that is a screen
  // with nothing on it.
  return summary === "" ? { summary: error, raw: undefined } : { summary, raw };
}

/** What the disclosure that hides the raw tails is labelled. Names both what is
 *  inside and that it is the evidence half, so it is not read as "more of the
 *  same". */
export const RAW_OUTPUT_SUMMARY_LABEL = "Show the raw output from the run (stdout and stderr tails)";

/* ------------------------------------------------------------------ *
 * A run must survive a reload
 * ------------------------------------------------------------------ */

/** Namespaced so it cannot collide with anything else this origin stores. The
 *  Vite dev server serves the editor and proxies the API on ONE origin, which
 *  is what makes `SameSite=Lax` work — and also means this key shares a storage
 *  area with anything else served from it. */
export const ACTIVE_RUN_STORAGE_KEY = "webgen.active-generation";

/** The two methods this module uses, so a test can supply a plain object and a
 *  windowless vitest run never touches a real `localStorage` (there is none). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `window.localStorage`, or `null` when it cannot be reached.
 *
 * The property ACCESS itself throws in a browser configured to block storage
 * (and the object is absent entirely under vitest), so this is a `try`, not a
 * `typeof` check. A tester with storage disabled loses reload-recovery and
 * keeps everything else, which is the right degradation — the alternative is a
 * white screen at mount.
 */
export function localRunStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The active run, restored across a reload.
 *
 * TOTAL by construction — it never throws for any input, because it is called
 * from `App`'s own `useState` initializer, where a throw takes the entire
 * hosted shell down before anything renders: a white screen with no way to
 * reach the picker and clear the offending value. Corrupt JSON, a half-written
 * entry, an array, a bare string, a numeric `jobId`, storage that refuses to be
 * read: all of them are `null`, which lands the tester on the picker.
 *
 * NOT scoped per user, deliberately. Two accounts on one machine can leave each
 * other's entry behind — and `GET /api/jobs/:id` answers a FOREIGN job with the
 * same 404 it gives an absent one, so the poll raises `JobGoneError`, the entry
 * is forgotten and the picker appears. The server's own uniform answer is the
 * check; a client-side user id here would be a second, weaker copy of it.
 */
export function restorePersistedRun(storage: StorageLike | null): StartedGeneration | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(ACTIVE_RUN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { jobId, projectId } = parsed as { jobId?: unknown; projectId?: unknown };
  if (typeof jobId !== "string" || jobId === "") return null;
  if (typeof projectId !== "string" || projectId === "") return null;
  return { jobId, projectId };
}

/**
 * Records the run in progress. Exactly two fields and nothing else: no email,
 * no session id, no key fingerprint. `localStorage` is readable by any script
 * on this origin and survives indefinitely, so the rule here is the same one
 * `publicJobView` follows on the server — an explicit field list, never a
 * spread of whatever the caller happened to be holding.
 */
export function persistRun(storage: StorageLike | null, started: StartedGeneration): void {
  if (storage === null) return;
  try {
    storage.setItem(
      ACTIVE_RUN_STORAGE_KEY,
      JSON.stringify({ jobId: started.jobId, projectId: started.projectId }),
    );
  } catch {
    // Safari private browsing throws `QuotaExceededError` on every `setItem`.
    // Losing reload-recovery is bad; losing the click that started a $1.74 run
    // is worse.
  }
}

/** Clears the entry. Called when a job reaches a terminal state, and when the
 *  server says the job is gone — a stale entry must never strand the UI. */
export function forgetPersistedRun(storage: StorageLike | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  } catch {
    // See `persistRun`.
  }
}

/* ------------------------------------------------------------------ *
 * degraded_sections
 * ------------------------------------------------------------------ */

/**
 * Three answers, not two. `none` and `unknown` are different facts, and
 * collapsing them into `[]` would make an unreadable summary claim a clean run
 * — the same class of lie as reporting `interrupted` as failed.
 */
export type DegradedReading =
  | { readonly kind: "none" }
  | { readonly kind: "some"; readonly sections: readonly string[] }
  | { readonly kind: "unknown" };

const DEGRADED_KEY = '"degraded_sections"';

/**
 * Finds the end of the JSON array that starts at `open`, honouring string
 * literals and their escapes so a `]` inside a value cannot end it early.
 * Returns -1 for an unterminated array — which is a REAL case here, not a
 * defensive one: the stored text is a fixed-length tail of a much longer
 * stdout and can be cut anywhere.
 */
function findArrayEnd(text: string, open: number): number {
  let inString = false;
  let escaped = false;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "]") return i;
    else if (ch === "[") return -1; // nested arrays are not a shape this field has
  }
  return -1;
}

/**
 * Digs `degraded_sections` out of a `generate` job's result.
 *
 * WHY THIS IS A SCAN AND NOT A `JSON.parse`, measured rather than assumed. Two
 * independent facts make whole-document parsing insufficient:
 *
 *  - The orchestrator prints progress lines to stdout BEFORE its final
 *    `json.dumps(result, indent=2)` — `fanout.py`'s `=== fan-out: spawning N
 *    page workers` and `=== <slug>: exit=0 duration=...`, plus each pipeline's
 *    `exec_id: ...`. The captured stdout is therefore not a JSON document at
 *    all; it is log lines followed by one.
 *  - `job-worker.ts` stores `JSON.stringify({ stdout: safeStdout.slice(-4000) })`
 *    — the LAST 4000 characters. The text routinely begins mid-object.
 *
 * So: find the LAST occurrence of the key (a brief becomes the project name and
 * could mention anything; the run summary is always last), then read the array
 * that follows. A whole-document `JSON.parse` is not attempted first because it
 * would succeed only in the case the scan already handles.
 *
 * Anything unexpected is `unknown`, never a throw and never a false `none`.
 */
export function readDegradedSections(result: unknown): DegradedReading {
  let text: string | undefined;
  if (typeof result === "string") {
    // `publicJobView` falls back to the raw `result_json` string when it will
    // not parse, so a caller can legitimately be holding one.
    text = result;
  } else if (result !== null && typeof result === "object") {
    const stdout = (result as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") text = stdout;
  }
  if (text === undefined) return { kind: "unknown" };

  const key = text.lastIndexOf(DEGRADED_KEY);
  if (key === -1) return { kind: "unknown" };
  const open = text.indexOf("[", key + DEGRADED_KEY.length);
  if (open === -1) return { kind: "unknown" };
  // Nothing but whitespace and the colon may sit between the key and the
  // bracket — otherwise the `[` belongs to some later field entirely.
  if (!/^\s*:\s*$/.test(text.slice(key + DEGRADED_KEY.length, open))) return { kind: "unknown" };
  const close = findArrayEnd(text, open);
  if (close === -1) return { kind: "unknown" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return { kind: "unknown" };
  }
  if (!Array.isArray(parsed)) return { kind: "unknown" };
  // Non-strings are dropped rather than stringified: rendering `[object
  // Object]` at a tester is worse than naming one section fewer, and this field
  // has only ever held `"<route>.<section>"` strings.
  const sections = parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return sections.length === 0 ? { kind: "none" } : { kind: "some", sections };
}

/* ------------------------------------------------------------------ *
 * Honest numbers
 * ------------------------------------------------------------------ */

/** Measured, not estimated: the live control run took 676.8s (11m 17s) and
 *  cost $1.7396 (docs/reports/m8-live-verification.md). */
const EXPECTED_RUN_MS = 11 * 60 * 1000;

/**
 * `11m 16s`, `45s`, `0s`. Floored rather than rounded, like
 * `lib/jobs.ts`'s own `formatElapsedSeconds`, so the clock never claims a
 * second that has not happened.
 *
 * Clamped at zero and guarded against non-finite input, because the baseline is
 * the SERVER's `createdAt` measured against the BROWSER's clock. Those are two
 * different clocks even on one machine, and a skewed one must not produce
 * "-4m 12s elapsed".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${String(seconds)}s` : `${String(minutes)}m ${String(seconds)}s`;
}

/**
 * The elapsed clock against the measured expectation — and, past it, an honest
 * admission rather than a stuck "of about 11 minutes" that reads as a hung run.
 * A run genuinely can take longer (676.8s was itself 94% over the m7 model's
 * own prediction), and there is nothing to do about it: there is no
 * cancellation.
 */
export function describeElapsed(elapsedMs: number): string {
  const clock = formatDuration(elapsedMs);
  if (elapsedMs < EXPECTED_RUN_MS) return `${clock} elapsed, of about 11 minutes.`;
  return `${clock} elapsed — longer than the ~11 minutes a measured run took. Runs vary; this one is still going.`;
}

/**
 * `sectionsGenerated` CAN EXCEED `sectionsTotal`, and this is measured, not
 * hypothetical: one live run generated 12 distinct sections against a plan of
 * 11, because the plan was revised after `plan.complete` was logged (and
 * `plan.complete` is what the total is read from). "12 of 11 sections" reads as
 * a bug in the UI; naming the discrepancy reads as the truth.
 *
 * `sectionsTotal` is also legitimately `null` — until `plan.complete` exists,
 * nobody knows the denominator.
 */
export function describeSections(generated: number, total: number | null): string {
  const done = Number.isFinite(generated) && generated > 0 ? Math.floor(generated) : 0;
  const noun = done === 1 ? "section" : "sections";
  if (total === null || !Number.isFinite(total) || total <= 0) {
    return `${String(done)} ${noun} generated`;
  }
  if (done > total) {
    return `${String(done)} ${noun} generated (the plan listed ${String(total)})`;
  }
  return `${String(done)} of ${String(total)} sections generated`;
}

/**
 * A bar width in [0, 1], or `null` when there is no honest denominator.
 * CLAMPED, for the same measured reason `describeSections` names: 12/11 is a
 * real value, and an unclamped one overflows its container.
 */
export function completionFraction(done: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(done) || done <= 0) return 0;
  return Math.min(1, done / total);
}

/* ------------------------------------------------------------------ *
 * DOGFOOD G2 — stop implying forward progress this screen cannot see
 * ------------------------------------------------------------------ */

/**
 * WHAT THIS FIX DOES NOT DO, stated first because it is the honest half.
 *
 * One dogfood run's `contact` page worker died at T+6:54 and the screen counted
 * happily up to "5 of 5 steps / 7 of 9 sections generated" for another 4.5
 * minutes, until the parent process exited at T+11:14. "7 of 9" reads as "nearly
 * there", not "one of two workers is gone".
 *
 * **There is no worker-death signal to render.** The run log has no such event:
 * three failure paths `continue` before the only code that would log one, and
 * that is `orchestrator/`/`server/` territory rather than this file's. So
 * nothing here invents one. What this screen CAN do is stop implying a
 * progression it cannot observe — say plainly what the counts are (finished
 * work, monotonic, read from a log) and say when they last moved.
 */
export const PROGRESS_COUNTS_CAVEAT =
  "These counts come from the run log and only ever go up: they record work that finished. A section that can no longer arrive is not reported at all, so a figure that stays still may mean a slow step or a stopped one — this page cannot tell those apart.";

/**
 * How long the numbers may stand still before the screen says so.
 *
 * Three minutes, chosen against measured behaviour rather than picked: a section
 * lands about every 27 s (`docs/reports/m7-wall-clock.md`), and the longest
 * legitimate silence measured is a retried design-system stage — 136 s + 141 s
 * on one real run, during which the step counter did move once. Below three
 * minutes this would fire on healthy runs; above it, it stops being news.
 */
export const PROGRESS_SILENCE_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * A fingerprint of everything the progress endpoint reports, so "nothing has
 * changed" means the numbers AND the stage name, not just the section count.
 * Two consecutive reads with the same signature are a silent interval.
 */
export function progressSignature(progress: ProgressView): string {
  return [
    progress.stage,
    progress.stagesDone,
    progress.stagesTotal,
    progress.sectionsGenerated,
    progress.sectionsTotal ?? "?",
  ].join("|");
}

/**
 * The silence line, or `null` while the gap is unremarkable.
 *
 * DELIBERATELY NOT A DIAGNOSIS. It names the observation, names the innocent
 * explanation with the measured figure that makes it plausible, and admits the
 * screen cannot separate the two — because it cannot. Reading this as "your run
 * has died" would be exactly the fabricated signal this fix refuses to add.
 */
export function describeProgressSilence(msSinceChange: number): string | null {
  if (!Number.isFinite(msSinceChange) || msSinceChange < PROGRESS_SILENCE_THRESHOLD_MS) return null;
  return `Nothing new has been reported for ${formatDuration(msSinceChange)}. A retried step can legitimately take that long — the design system took 4m 37s across two attempts on one measured run — and this page cannot tell that apart from a step that has stopped. The run is spending either way.`;
}

/* ------------------------------------------------------------------ *
 * The poll loop
 * ------------------------------------------------------------------ */

/** The brief's cadence, named rather than inlined so it can be audited. */
export const JOB_POLL_INTERVAL_MS = 3000;
export const PROGRESS_POLL_INTERVAL_MS = 5000;

/**
 * How many CONSECUTIVE job reads may fail before the loop gives up. Generous on
 * purpose: a server restart mid-run is exactly what produces `interrupted`, and
 * the job endpoint is unreachable for the whole restart window. Giving up early
 * means the tester never sees the state they were most likely to hit. 20 reads
 * at 3s is a full minute of unreachability tolerated.
 */
export const MAX_CONSECUTIVE_JOB_READ_FAILURES = 20;

/** The job row is gone, or was never this session's — `GET /api/jobs/:id`
 *  answers both with one 404, deliberately, so a job id is not an enumeration
 *  oracle. Its own class because the UI's response is specific: forget the
 *  persisted entry and return to the picker. */
export class JobGoneError extends Error {
  constructor() {
    super("that generation no longer exists");
    this.name = "JobGoneError";
  }
}

/** The server could not be reached for long enough that polling stopped. NOT a
 *  generation failure — the run is very probably still going, and spend
 *  continues either way. */
export class PollLostContactError extends Error {
  constructor(detail: string) {
    super(`lost contact with the server while watching this generation (${detail})`);
    this.name = "PollLostContactError";
  }
}

/** The caller went away (unmount, sign-out). Never surfaced to a user. */
export class PollCancelledError extends Error {
  constructor() {
    super("polling cancelled");
    this.name = "PollCancelledError";
  }
}

export interface PollOptions {
  readonly jobId: string;
  readonly fetchImpl?: typeof fetch;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly jobIntervalMs?: number;
  readonly progressIntervalMs?: number;
  readonly maxConsecutiveJobErrors?: number;
  readonly onJob?: (job: JobView) => void;
  readonly onProgress?: (progress: ProgressView) => void;
  /** Called with the running count of consecutive failed job reads, so the UI
   *  can say "reconnecting" instead of silently freezing. */
  readonly onConnectionTrouble?: (consecutive: number) => void;
  readonly isCancelled?: () => boolean;
}

export interface PollResult {
  readonly status: TerminalJobStatus;
  readonly result?: unknown;
  readonly error?: string;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "interrupted"]);
const POLLING_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wrapped rather than aliased: a bare `const f = fetch; f(...)` invokes the
 *  global with the wrong receiver and throws "Illegal invocation" in a
 *  browser. */
function resolveFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  return fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
}

/**
 * Polls `GET /api/jobs/:id` until it reaches a terminal status, reading
 * `GET /api/jobs/:id/progress` alongside it on a slower cadence.
 *
 * THE JOB IS AUTHORITATIVE AND PROGRESS IS ADVISORY, and the asymmetry in the
 * code is deliberate rather than incidental:
 *
 *  - A progress read that fails IN ANY WAY — a 502 from the Vite proxy, a 404,
 *    a rejected promise from a dropped connection, a body that is not a
 *    progress report — is swallowed whole and the loop carries on. Task 1's
 *    endpoint never reports a terminal state (a run log cannot distinguish "all
 *    sections done" from "the process died"), so it can only ever be a garnish
 *    on the answer, never the answer.
 *  - A job read that fails is TOLERATED but COUNTED. A restart window is
 *    survivable and is the case worth surviving; an indefinitely dead server is
 *    not, and polling it forever is how a screen appears frozen with nothing
 *    said.
 *
 * Two failures are NOT tolerated at all, because each is its own honest state:
 * a 401 (`SessionExpiredError` — reporting "generation failed" for a session
 * that merely lapsed is the same lie `interrupted` exists to prevent) and a 404
 * (`JobGoneError` — a stale persisted entry must return the tester to the
 * picker, not spin forever on a job nobody has).
 */
export async function pollUntilTerminal(options: PollOptions): Promise<PollResult> {
  const doFetch = resolveFetch(options.fetchImpl);
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;
  const jobIntervalMs = options.jobIntervalMs ?? JOB_POLL_INTERVAL_MS;
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_POLL_INTERVAL_MS;
  const maxErrors = options.maxConsecutiveJobErrors ?? MAX_CONSECUTIVE_JOB_READ_FAILURES;

  let consecutiveErrors = 0;
  let lastProgressAt: number | null = null;

  for (;;) {
    if (options.isCancelled?.() === true) throw new PollCancelledError();

    let job: JobView;
    try {
      job = await readJob(doFetch, options.jobId);
    } catch (error) {
      // The two states that are NOT "the server hiccuped" propagate untouched.
      if (error instanceof SessionExpiredError || error instanceof JobGoneError) throw error;
      consecutiveErrors += 1;
      options.onConnectionTrouble?.(consecutiveErrors);
      if (consecutiveErrors >= maxErrors) {
        throw new PollLostContactError(error instanceof Error ? error.message : String(error));
      }
      await wait(jobIntervalMs);
      continue;
    }
    consecutiveErrors = 0;
    options.onJob?.(job);

    if (TERMINAL_STATUSES.has(job.status)) {
      // Returns BEFORE any further progress read: once the outcome is known, a
      // progress read can only contradict it.
      return { status: job.status as TerminalJobStatus, result: job.result, error: job.error };
    }

    if (lastProgressAt === null || now() - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now();
      const progress = await readProgressQuietly(doFetch, options.jobId);
      if (progress !== null) options.onProgress?.(progress);
    }

    await wait(jobIntervalMs);
  }
}

async function readJob(doFetch: typeof fetch, jobId: string): Promise<JobView> {
  const response = await doFetch(jobUrl(jobId), { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) throw new SessionExpiredError();
  if (response.status === 404) throw new JobGoneError();
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const body = (await response.json()) as { status?: unknown };
  const status = body.status;
  // An `as` cast asserts a shape; this checks one. A 200 whose body is not a
  // job at all (a proxy's own page, a future status this build does not know)
  // must never fall through as a fabricated terminal outcome — the exact defect
  // `lib/jobs.ts` had to be fixed for. Counted as a read failure rather than
  // thrown outright, because a proxy hiccup is transient like any other.
  if (typeof status !== "string" || (!TERMINAL_STATUSES.has(status) && !POLLING_STATUSES.has(status))) {
    throw new Error(`unrecognised job status: ${JSON.stringify(status)}`);
  }
  return body as JobView;
}

/**
 * Reads progress, or returns `null`. Never throws, for any reason. This is the
 * whole of "progress is advisory" — a `try` that let one error class through
 * would put a failed progress read back on the path to a reported failure.
 */
async function readProgressQuietly(doFetch: typeof fetch, jobId: string): Promise<ProgressView | null> {
  try {
    const response = await doFetch(jobProgressUrl(jobId), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ProgressView>;
    if (typeof body.stage !== "string") return null;
    return {
      stage: body.stage,
      stagesDone: typeof body.stagesDone === "number" ? body.stagesDone : 0,
      stagesTotal: typeof body.stagesTotal === "number" ? body.stagesTotal : 0,
      sectionsGenerated: typeof body.sectionsGenerated === "number" ? body.sectionsGenerated : 0,
      sectionsTotal: typeof body.sectionsTotal === "number" ? body.sectionsTotal : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

/**
 * Re-runs a FAILED job from the step it failed on, and resolves with the NEW
 * job id — a resume is a new job row carrying the original's `run_id`, which is
 * itself the resume mechanism (completed Kitaru checkpoints hit the cache; the
 * failed one has nothing cached).
 *
 * Every refusal is surfaced in the SERVER's own words, because each names a
 * different fix and the server already words them: 409 for a `code_version`
 * mismatch ("start a fresh job instead" — Kitaru keys its cache on function
 * code plus args, so a changed checkpoint re-executes while a paired one
 * silently skips its side effect), 409 for a job that is not failed, 409 for a
 * resume already in flight, 402 over the spend cap (retrying cannot help until
 * the window rolls), 429 over the concurrent-job bound (retrying DOES help).
 * Rewording any of them here would flatten distinctions that are the whole
 * value of the message.
 */
export async function resumeJob(jobId: string, options: RequestOptions = {}): Promise<string> {
  const response = await resolveFetch(options.fetchImpl)(jobResumeUrl(jobId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  if (response.status === 401) throw new SessionExpiredError();
  if (response.status !== 202) {
    // The same discrimination rule `startGeneration` and `lib/jobs.ts` use: 202
    // is the one status reserved for "a job now exists, go poll for it". A 200
    // carrying an identical-looking body is some other server, or a proxy that
    // swallowed the request.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = (body as { error?: unknown } | undefined)?.error;
    throw new Error(
      typeof error === "string" && error !== ""
        ? error
        : `Could not resume this generation (HTTP ${String(response.status)}).`,
    );
  }
  const body = (await response.json()) as { jobId?: unknown };
  if (typeof body.jobId !== "string" || body.jobId === "") {
    throw new Error("The server accepted the resume but did not say which job it started.");
  }
  return body.jobId;
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export interface GenerationProgressProps {
  readonly jobId: string;
  readonly projectId: string;
  /** The run succeeded and the tester chose to open it. */
  readonly onDone: (projectId: string) => void;
  /**
   * Leave this screen without opening the project — used for a job that is
   * GONE (a stale persisted entry, a foreign job, a wiped database) and for the
   * "back to your sites" affordance that appears only AFTER a run is over.
   *
   * There is deliberately no `onFailed`: a failed job does not leave this
   * screen, it offers Resume here, because the alternative (dropping the tester
   * back at the picker) both loses the error message and puts the Generate
   * button back in front of someone whose last run already cost money.
   */
  readonly onAbandon: () => void;
  /** A 401 is its own state, distinguishable from a job failure. */
  readonly onSessionExpired: () => void;
  /** A resume produced a NEW job id; the caller re-points this screen at it
   *  (and re-persists it, so the resume survives a reload too). */
  readonly onResumed: (jobId: string) => void;
}

type Phase =
  | { readonly kind: "polling" }
  | { readonly kind: "terminal"; readonly outcome: PollResult }
  | { readonly kind: "lost-contact"; readonly message: string };

/**
 * A plausible elapsed-time baseline, or `null`.
 *
 * The server's epochs and the browser's clock are different clocks. A baseline
 * in the future (skew, or a clock set wrong) would produce a negative elapsed
 * time that ticks backwards, so an implausible value is refused and the mount
 * time is kept instead — one wrong number beats a nonsensical one.
 */
function baselineFor(job: JobView, fallback: number): number {
  const candidate = job.startedAt ?? job.createdAt;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback;
  if (candidate > Date.now() + 60_000) return fallback;
  return candidate;
}

export default function GenerationProgress({
  jobId,
  projectId,
  onDone,
  onAbandon,
  onSessionExpired,
  onResumed,
}: GenerationProgressProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "polling" });
  const [progress, setProgress] = useState<ProgressView | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // G2. How long the reported numbers have stood still. Driven by the same 1s
  // ticker as `elapsedMs` and measured from the last read whose SIGNATURE
  // differed, not from the last read that arrived — a poll that returns the
  // identical report is not progress, and treating it as one is what let a
  // screen with a dead worker behind it look busy for 4.5 minutes.
  const [silenceMs, setSilenceMs] = useState(0);
  const [trouble, setTrouble] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | undefined>(undefined);
  /** Bumped to restart the poll after "lost contact". */
  const [attempt, setAttempt] = useState(0);

  // Stamped once, then recomputed from — never accumulated. App.tsx's own
  // elapsed displays carry the same note: a tick that adds 1000ms to the last
  // displayed value drifts under background-tab throttling, where a browser can
  // clamp `setInterval` to well over a second, so ONE late tick makes every
  // number after it wrong for the rest of the run.
  const baselineRef = useRef(Date.now());
  const baselineKnownRef = useRef(false);
  /** G2. When the reported progress last actually changed, and what it said then.
   *  `null` until the first progress read arrives: before that there is nothing
   *  to be silent ABOUT, and starting the clock at mount would accuse a run of
   *  stalling while it was still starting up. */
  const progressChangedAtRef = useRef<number | null>(null);
  const progressSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "polling" });
    setTrouble(0);
    void pollUntilTerminal({
      jobId,
      isCancelled: () => cancelled,
      onJob: (job) => {
        if (cancelled) return;
        setTrouble(0);
        if (!baselineKnownRef.current) {
          baselineRef.current = baselineFor(job, baselineRef.current);
          baselineKnownRef.current = true;
          // Republished immediately rather than left to the next 1s tick.
          // Measured live: on a run already 250s old, the screen showed
          // "0s elapsed" for a full second after it appeared, because the
          // ticker starts at mount (baseline = now) and the real baseline only
          // arrives with the first poll. One second of a visibly wrong number
          // is one second of a tester believing the run just started.
          setElapsedMs(Date.now() - baselineRef.current);
        }
      },
      onProgress: (next) => {
        if (cancelled) return;
        // Compared here rather than inside the state updater on purpose: an
        // updater can be invoked more than once for one update (React's own
        // strict-mode double-invocation), and a side effect in there would
        // re-stamp the clock on a re-render and hide every silence.
        const signature = progressSignature(next);
        if (progressSignatureRef.current !== signature) {
          progressSignatureRef.current = signature;
          progressChangedAtRef.current = Date.now();
          setSilenceMs(0);
        }
        setProgress(next);
      },
      onConnectionTrouble: (consecutive) => {
        if (!cancelled) setTrouble(consecutive);
      },
    })
      .then((outcome) => {
        if (cancelled) return;
        // The run is over: the entry must not survive to re-enter a finished
        // run on the next reload.
        forgetPersistedRun(localRunStorage());
        setPhase({ kind: "terminal", outcome });
      })
      .catch((error: unknown) => {
        if (cancelled || error instanceof PollCancelledError) return;
        if (error instanceof SessionExpiredError) {
          // The entry is deliberately KEPT: the run is very likely still going,
          // and signing back in should return the tester to it.
          onSessionExpired();
          return;
        }
        if (error instanceof JobGoneError) {
          forgetPersistedRun(localRunStorage());
          onAbandon();
          return;
        }
        setPhase({
          kind: "lost-contact",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, attempt]);

  useEffect(() => {
    if (phase.kind === "terminal") return;
    const tick = () => {
      setElapsedMs(Date.now() - baselineRef.current);
      const changedAt = progressChangedAtRef.current;
      setSilenceMs(changedAt === null ? 0 : Date.now() - changedAt);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase.kind]);

  async function onResume() {
    if (resuming) return;
    setResuming(true);
    setResumeError(undefined);
    try {
      const nextJobId = await resumeJob(jobId);
      // No `setResuming(false)`: this screen is about to be re-pointed at the
      // new job, and re-enabling the button first offers a second resume of a
      // job that is already resuming (the server answers 409, but the tester
      // should not have to read it).
      onResumed(nextJobId);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired();
        return;
      }
      setResumeError(error instanceof Error ? error.message : String(error));
      setResuming(false);
    }
  }

  const stageFraction = completionFraction(progress?.stagesDone ?? 0, progress?.stagesTotal ?? null);
  const sectionFraction = completionFraction(
    progress?.sectionsGenerated ?? 0,
    progress?.sectionsTotal ?? null,
  );
  const silence = describeProgressSilence(silenceMs);

  if (phase.kind !== "terminal") {
    return (
      <div className="generation-progress" data-testid="generation-running">
        <h1 className="progress-heading">Generating your site</h1>
        <p className="progress-stage" data-testid="progress-stage">
          {progress === null ? "starting" : progress.stage}
        </p>

        <div className="progress-rows">
          <ProgressRow
            label="Plan, design system, app shell"
            detail={
              progress === null
                ? "0 of 5 steps"
                : `${String(Math.min(progress.stagesDone, progress.stagesTotal))} of ${String(progress.stagesTotal)} steps`
            }
            fraction={stageFraction}
          />
          <ProgressRow
            label="Sections"
            detail={describeSections(
              progress?.sectionsGenerated ?? 0,
              progress?.sectionsTotal ?? null,
            )}
            fraction={sectionFraction}
          />
        </div>

        {/* G2 — under the bars, because the bars are what implied the
            progression. Always shown, not only when something looks wrong: it
            is a statement about what these numbers ARE, and it is as true at
            "1 of 9" as at "7 of 9". */}
        <p className="progress-footnote" data-testid="progress-counts-caveat">
          {PROGRESS_COUNTS_CAVEAT}
        </p>

        <p className="progress-elapsed" data-testid="progress-elapsed">
          {describeElapsed(elapsedMs)}
        </p>

        {/* G2 — the observation, once the numbers have genuinely stood still
            for longer than any measured healthy gap. Not a diagnosis: there is
            no worker-death event in the run log to read, so this says what it
            saw and admits what it cannot distinguish. */}
        {silence !== null && (
          <p className="progress-trouble-line" data-testid="progress-silence" role="status">
            {silence}
          </p>
        )}

        {phase.kind === "lost-contact" ? (
          <div className="progress-trouble" data-testid="progress-lost-contact" role="alert">
            <p>
              This page has lost contact with the server, so it can no longer tell you how the run is
              going. <strong>The generation itself is unaffected</strong> — it runs on the server and
              cannot be cancelled, so it is still spending and still working.
            </p>
            <p className="progress-footnote">{phase.message}</p>
            <button
              type="button"
              className="progress-secondary"
              data-testid="progress-retry"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try watching again
            </button>
          </div>
        ) : (
          trouble > 0 && (
            <p className="progress-trouble-line" data-testid="progress-reconnecting" role="status">
              Reconnecting to the server ({String(trouble)} failed checks). The run is unaffected.
            </p>
          )
        )}

        {/* Stated while the money is being spent, not after. There is no
            cancellation — spec decision 13: the orchestrator subprocess cannot
            be safely killed — so closing this tab, or pressing anything here,
            changes nothing about the bill. Deliberately NO "open the project"
            (the project row and its directory exist from the first moment, but
            the directory stays empty for ~11 minutes, so opening it bootstraps
            a canvas against a manifest that does not exist) and NO "back to
            your sites" (it would put the Generate button back in front of
            someone whose run is already costing money). */}
        <p className="progress-footnote">
          A full run cost about $1.74 and took about 11 minutes when measured. It{" "}
          <strong>cannot be cancelled</strong> — closing this tab or signing out does not stop it, and
          the spend continues either way. You can safely reload: this page will find the run again.
        </p>
        <p className="progress-footnote progress-jobid">
          job <code>{jobId}</code>
        </p>
      </div>
    );
  }

  const { outcome } = phase;
  const degraded = outcome.status === "succeeded" ? readDegradedSections(outcome.result) : { kind: "unknown" as const };
  // G6. A failure this screen can EXPLAIN rather than merely print. `null` for
  // every other failure, which keeps the ordinary failed screen exactly as it
  // is — including its Resume primary, which is the right primary there.
  const known = outcome.status === "failed" ? recogniseKnownFailure(outcome.error) : null;
  const failureText = outcome.error === undefined ? undefined : splitFailureMessage(outcome.error);

  return (
    <div className="generation-progress" data-testid="generation-terminal" data-status={outcome.status}>
      <h1 className="progress-heading">
        {known === null ? TERMINAL_HEADINGS[outcome.status] : known.heading}
      </h1>
      <p className="progress-body" data-testid="terminal-message">
        {known === null ? describeTerminal(outcome.status) : describeKnownFailure(known)}
      </p>
      <p className="progress-elapsed">{formatDuration(elapsedMs)} elapsed.</p>

      {outcome.status === "succeeded" && degraded.kind === "some" && (
        <div className="progress-degraded" data-testid="degraded-sections" role="status">
          <p>
            <strong>
              {degraded.sections.length === 1
                ? "One section could not be generated"
                : `${String(degraded.sections.length)} sections could not be generated`}
              .
            </strong>{" "}
            Each failed its validation gates on all 3 attempts, so the page ships it as a placeholder
            box instead. That is why the site renders with a grey panel where the content should be.
          </p>
          <ul className="progress-degraded-list">
            {degraded.sections.map((section) => (
              <li key={section}>
                <code>{section}</code>
              </li>
            ))}
          </ul>
          <p className="progress-footnote">
            Everything else generated normally. The placeholder itself{" "}
            <strong>cannot be clicked</strong> — it carries no node id by design, because no agent
            ever produced a valid section to register. Regenerate the <em>page</em> it sits on
            instead: the part of the id before the dot is the route. That re-runs only that page,
            not the whole site.
          </p>
        </div>
      )}

      {outcome.status === "succeeded" && degraded.kind === "unknown" && (
        <p className="progress-footnote" data-testid="degraded-unknown">
          The run summary could not be read, so any section that failed all 3 attempts is not listed
          here. If a page shows a grey placeholder box, regenerate that whole page — the placeholder
          cannot be clicked, because it carries no node id.
        </p>
      )}

      {outcome.status === "failed" && (
        <>
          {/* G6. The message wave 1 built has its answer in the first lines and
              its evidence in the stream tails below; rendering both as one wall
              of red is why a tester's takeaway was `Bytecode compiled 6239
              files in 889ms`. The answer stays visible, the bytes stay one
              click away, and nothing is dropped. */}
          {failureText !== undefined && (
            <pre className="progress-error" data-testid="generation-error">
              {failureText.summary}
            </pre>
          )}
          {failureText?.raw !== undefined && (
            <details className="progress-raw" data-testid="generation-error-raw">
              <summary>{RAW_OUTPUT_SUMMARY_LABEL}</summary>
              <pre className="progress-error">{failureText.raw}</pre>
            </details>
          )}
          {resumeError !== undefined && (
            <p className="progress-error-line" data-testid="resume-error" role="alert">
              {resumeError}
            </p>
          )}
          {/* G6, THE SECOND HALF: the right primary action.
              For the recognised first-run refusal the documented fix is to
              submit the brief again, and Resume was the big blue button while
              that lived behind a smaller secondary. So for THAT failure the
              submit-again action is primary and Resume is demoted — not
              removed, because a resume of a run that never started is harmless
              and a tester may prefer it. For every other failure Resume stays
              primary, which is correct: it does not pay for completed steps
              twice. */}
          {known !== null && (
            <button
              type="button"
              className="progress-primary"
              data-testid="submit-again"
              onClick={() => onAbandon()}
            >
              {known.primaryLabel}
            </button>
          )}
          <button
            type="button"
            className={known === null ? "progress-primary" : "progress-secondary"}
            data-testid="resume-button"
            onClick={() => void onResume()}
            disabled={resuming}
          >
            {resuming ? "Resuming…" : "Resume from where it stopped"}
          </button>
          <p className="progress-footnote">
            A resume re-runs only the step that failed — the completed steps are cached, so it does
            not pay for them twice. It is refused if the server has been restarted on different code
            since the run, because a cached step would then silently skip work; start a fresh brief
            in that case.
          </p>
          {known !== null && (
            <p className="progress-footnote" data-testid="submit-again-footnote">
              “{known.primaryLabel}” takes you back to your sites, where the brief box is. The brief
              itself is not kept anywhere, so paste it in again.
            </p>
          )}
        </>
      )}

      {outcome.status === "succeeded" && (
        <button
          type="button"
          className="progress-primary"
          data-testid="open-project"
          onClick={() => onDone(projectId)}
        >
          Open the site
        </button>
      )}

      {/* Available only now the run is over: while it was going, this would
          have re-exposed the Generate button during a paid run. */}
      <button
        type="button"
        className="progress-secondary"
        data-testid="back-to-sites"
        onClick={() => onAbandon()}
      >
        Back to your sites
      </button>
    </div>
  );
}

function ProgressRow({
  label,
  detail,
  fraction,
}: {
  label: string;
  detail: string;
  fraction: number | null;
}) {
  return (
    <div className="progress-row">
      <div className="progress-row-head">
        <span className="progress-row-label">{label}</span>
        <span className="progress-row-detail">{detail}</span>
      </div>
      <div className="progress-track">
        {/* `fraction` is already clamped to [0, 1] — see `completionFraction`.
            An unclamped 12/11 would overflow the track. */}
        <div
          className="progress-fill"
          style={{ width: `${String(Math.round((fraction ?? 0) * 100))}%` }}
        />
      </div>
    </div>
  );
}
