// server/src/progress-routes.ts
/**
 * `GET /api/jobs/:id/progress` — how far along a long-running job actually is.
 *
 * WHY THIS READS THE RUN LOG RATHER THAN A `progress` COLUMN (the design
 * decision, not a preference): the orchestrator already appends one event per
 * completed stage to `orchestrator/runlog/<run_id>.jsonl`, and
 * `orchestrator.run_report` already treats that log as authoritative. A
 * `progress` column on `job` would be a SECOND write path over the same fact,
 * updated by a different process than the one doing the work, and the two can
 * disagree — at which point neither is trustworthy. Nothing new is written
 * here at all: this endpoint is a reader.
 *
 * Three properties are load-bearing, and each is easy to break by accident:
 *
 *   - SESSION-ONLY, owner-checked on `job.user_id`, answering
 *     `require-project.ts`'s shared `NOT_FOUND` constant for a foreign job and
 *     an absent one IDENTICALLY, in one branch — exactly as
 *     `job-routes.ts`'s `GET /api/jobs/:id` does, and for the same reason: two
 *     distinguishable answers make a job id an enumeration oracle. It is
 *     session-only rather than `requireProject`-wrapped because a job belongs
 *     to the user who queued it, and a generate job's `project_id` is
 *     `ON DELETE SET NULL` — see that endpoint's own comment.
 *
 *   - The `run_id` comes from the JOB ROW, never from the request. The run-log
 *     directory is shared by every tenant (one `orchestrator/runlog/`), so the
 *     only thing separating one user's log from another's here is the owner
 *     check above plus the fact that a client cannot name a run id at all. A
 *     future `?runId=` parameter on this endpoint would hand every log to
 *     everyone; there is deliberately no way to pass one.
 *
 *   - The run id is validated with `jobs.ts`'s `isSafeRunId` BEFORE it reaches
 *     a path. Every value in the `run_id` column was already validated on the
 *     way in (`recordJobRun` throws, `job-worker.ts` pre-checks), so this is
 *     defence in depth against a hand-edited row or a future writer — but this
 *     codebase has shipped four `..` defects at four layers, one of them a
 *     `runId` rail whose regex `^[A-Za-z0-9._-]+$` matched `..` because `.` is
 *     in the character class. The helper, never a fresh check.
 *
 * NOT BILLABLE, and never `requireBudget`-wrapped: reading how far a run got
 * must not be refused because the run itself put the user over their cap. A
 * user who cannot see their progress reports "it seemed stuck," which is the
 * exact failure this endpoint exists to prevent.
 *
 * WHAT THIS ENDPOINT DELIBERATELY DOES NOT SAY: whether the job finished.
 * `GET /api/jobs/:id` is authoritative for status, and progress is advisory —
 * a run log cannot tell "all sections done" from "the process died after the
 * last section," and inventing a terminal state here would be the same lie
 * `interrupted` exists to prevent. A caller polls both, and believes the job
 * row about the outcome. Nor does it echo the `run_id` itself: `publicJobView`
 * omits it on purpose, and a caller needs none of it to render progress.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { findJobById, isSafeRunId } from "./jobs.ts";
import { NOT_FOUND } from "./require-project.ts";
import { requireSession } from "./require-session.ts";
import { sendJson, type Route } from "./router.ts";

/**
 * The five one-off stages a full generation runs before any section: intake,
 * the site plan, design tokens, primitives, and the app shell (the pipeline's
 * own order, and the order these appear in a real log).
 *
 * Counted as a SET, never as a running total of events: `primitives.complete`
 * is logged TWICE in a real run (the design step retries, and a retried
 * checkpoint is logged as if it were a new stage), so a naive count reports 6
 * of 5 done. Measured on a live run's log, not assumed.
 */
export const PRELUDE_STAGES: readonly string[] = [
  "intake.complete",
  "plan.complete",
  "tokens.complete",
  "primitives.complete",
  "shell.complete",
];

const PRELUDE_STAGE_SET = new Set(PRELUDE_STAGES);

/**
 * The human-readable phase names this endpoint reports. Exported so a UI (and
 * this module's own tests) can compare against the constant rather than
 * retyping a string literal that would then drift silently.
 *
 * Each names what is CURRENTLY RUNNING, inferred from the highest milestone
 * the log has reached — not the milestone itself. `tokens.complete` and
 * `plan.complete` therefore share one phase: tokens and primitives are both
 * the Design System Agent's work, and a user watching does not care which of
 * the two is in flight.
 */
export const PROGRESS_STAGES = {
  starting: "starting",
  planning: "planning the site",
  design: "generating the design system",
  shell: "generating the app shell",
  sections: "generating sections",
} as const;

/**
 * A bound on the returned timeline, not a normal path: a measured full
 * generation logs about 40 events. The counts below are computed over the
 * WHOLE log regardless of this cap, so trimming costs a caller nothing but
 * timeline depth — and the most recent events are the ones a progress view
 * shows, which is why the tail is kept rather than the head.
 */
export const MAX_PROGRESS_EVENTS = 500;

/** Name pinned against `orchestrator/src/orchestrator/config.py`'s own `runlog_dir()` by a test in this module's suite. */
export const ORCHESTRATOR_RUNLOG_DIR_ENV_VAR = "ORCHESTRATOR_RUNLOG_DIR";

/**
 * Resolved from this file's own URL, never a hardcoded absolute path — the
 * same technique `job-worker.ts`'s `DEFAULT_ORCHESTRATOR_DIR` and
 * `preview-pool.ts`'s `DEFAULT_PREVIEW_SCRIPT` use, for the same reason (the
 * repo can be checked out anywhere).
 */
const DEFAULT_RUNLOG_DIR = fileURLToPath(new URL("../../orchestrator/runlog", import.meta.url));

/**
 * Where the orchestrator ACTUALLY writes its run logs, derived here exactly
 * the way the orchestrator derives it for itself (`config.py`'s
 * `runlog_dir()`: `ORCHESTRATOR_RUNLOG_DIR`, else `ORCHESTRATOR_ROOT /
 * "runlog"`).
 *
 * The environment variable is honoured rather than ignored because
 * `buildAgentEnv` hands the orchestrator child a COPY of this process's
 * environment (minus the master key and the host's own API key) — so an
 * operator who sets `ORCHESTRATOR_RUNLOG_DIR` for the server moves the
 * child's logs with it, and a server that ignored the variable would report
 * zero progress forever with nothing obviously wrong. Same class of silent
 * disagreement `assertProjectsRootMatchesOrchestrator` exists to refuse,
 * closed here by agreeing instead of by refusing (this is a read: there is
 * nothing to spend and nothing to lose).
 */
export function defaultRunlogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ORCHESTRATOR_RUNLOG_DIR_ENV_VAR];
  return override === undefined || override === "" ? DEFAULT_RUNLOG_DIR : override;
}

export interface ProgressEvent {
  /** The log's own `event_type`, verbatim. */
  type: string;
  /** The log's ISO `timestamp`, or null for a line that carried none. */
  at: string | null;
}

export interface ProgressReport {
  /** One of `PROGRESS_STAGES`' values — what is running now. */
  stage: string;
  /** Distinct prelude stages completed, 0..`stagesTotal`. */
  stagesDone: number;
  /** Always `PRELUDE_STAGES.length`, so a caller need not hardcode the denominator. */
  stagesTotal: number;
  /**
   * DISTINCT sections that have had at least one generation attempt — not the
   * number of attempts. See `sectionKeyFor` for why the two differ by a lot.
   */
  sectionsGenerated: number;
  /**
   * How many sections the approved plan contains, read from `plan.complete`'s
   * own payload — null until that event exists, because until then nobody
   * knows.
   *
   * A caller must treat this as the plan's INTENT, not a hard denominator:
   * measured against real logs, `sectionsGenerated` can exceed it (one live
   * run generated 12 distinct sections against a plan of 11, the plan having
   * been revised after `plan.complete` was logged). Render `min`, or render
   * "12 sections" — never assert one is ≤ the other.
   */
  sectionsTotal: number | null;
  /** The log's timeline, `type` + `timestamp` only, trimmed to the last `MAX_PROGRESS_EVENTS`. */
  events: ProgressEvent[];
}

/**
 * The answer for a job with nothing to report yet — a fresh object per call,
 * never one shared mutable constant handed to two responses.
 *
 * This is a 200, never a 404: a `queued` job has no `run_id` at all, and a
 * `running` one has no log until its first stage completes. A tester polling
 * the instant they press the button is the COMMON case, and an error there
 * reads as "something broke" when the honest answer is "nothing has happened
 * yet."
 */
export function notStartedProgress(): ProgressReport {
  return {
    stage: PROGRESS_STAGES.starting,
    stagesDone: 0,
    stagesTotal: PRELUDE_STAGES.length,
    sectionsGenerated: 0,
    sectionsTotal: null,
    events: [],
  };
}

/**
 * How many sections the plan describes: `plan.complete`'s `raw_output` is the
 * planner's own JSON as a STRING (`{ routes: [{ sections: [...] }] }`).
 *
 * Every step is guarded and any surprise returns null rather than throwing:
 * this is model-generated content reached through two layers of parsing, and
 * a planner that emitted an unexpected shape must degrade to "total unknown",
 * never to a 500 on a status poll.
 */
function countPlannedSections(rawOutput: unknown): number | null {
  if (typeof rawOutput !== "string" || rawOutput === "") return null;
  let plan: unknown;
  try {
    plan = JSON.parse(rawOutput);
  } catch {
    return null;
  }
  if (plan === null || typeof plan !== "object") return null;
  const routes = (plan as Record<string, unknown>).routes;
  if (!Array.isArray(routes)) return null;
  let total = 0;
  for (const route of routes) {
    if (route === null || typeof route !== "object") continue;
    const sections = (route as Record<string, unknown>).sections;
    if (Array.isArray(sections)) total += sections.length;
  }
  return total;
}

/**
 * The identity of the section a `section.generated` event is about — the whole
 * reason `sectionsGenerated` is not just a count of those events.
 *
 * A section is generated MORE THAN ONCE whenever a gate retry fires, so the
 * raw event count is an attempt count. Measured across four real run logs:
 * 12 events / 9 sections, 19 / 12, 21 / 9, 10 / 10.
 *
 * WHICH KEY, AND WHY — the brief offered the `checkpoint_ref` prefix
 * (`ref.split("/")[0]`, Kitaru's execution id). Measured against those same
 * four logs, that prefix OVER-counts whenever a retry re-executes the flow
 * rather than looping inside it: 18 distinct prefixes for 12 real sections in
 * one run, 13 for 9 in another. The fully-qualified `section` field
 * (`"home.hero"`) matched the true section count in all four, and matched the
 * prefix count exactly in the two runs that had no cross-execution retry. So
 * `section` is preferred, with the prefix as a fallback for a log that lacks
 * it, and the event's own line index as a last resort.
 *
 * The line-index fallback counts an unattributable event as its own section.
 * That is the right direction to err: real logs always carry both fields (both
 * event writers pass them), so this only ever applies to a hand-written or
 * legacy log, and over-counting shows a run moving while under-counting makes
 * a live run look stuck — the one thing this endpoint exists to prevent. The
 * two namespaces are prefixed so a section slug can never collide with an
 * execution id.
 */
function sectionKeyFor(event: Record<string, unknown>, lineIndex: number): string {
  const section = event.section;
  if (typeof section === "string" && section !== "") return `section:${section}`;
  const ref = event.checkpoint_ref;
  if (typeof ref === "string" && ref !== "") {
    const prefix = ref.split("/")[0];
    if (prefix !== undefined && prefix !== "") return `ref:${prefix}`;
  }
  return `line:${lineIndex}`;
}

/**
 * The whole reader, as a pure function of the log's text — so every counting
 * rule above is testable without a database, a session, or a filesystem.
 *
 * Two robustness properties, both real rather than theoretical:
 *   - the log is being APPENDED TO by another process while this reads it, so
 *     the final line can be half-written. An unparseable line is skipped, not
 *     thrown on. This is a load-bearing line of code: making the parse throw
 *     instead fails this module's own truncated-line test.
 *   - the Python writer opens the file in text mode, so on Windows every line
 *     ends `\r\n` and a bare `split("\n")` leaves a trailing `\r` on each one.
 *     Confirmed against this machine's own live-run logs (30 CR for 30 LF).
 *     Honest note on what actually makes that work: `JSON.parse` already
 *     ignores surrounding whitespace, `\r` included, so the `trim()` below is
 *     defence and clarity (it makes the blank-line check mean what it says) —
 *     NOT the mechanism. Removing it alone breaks nothing, verified by
 *     perturbation rather than assumed either way.
 */
export function summarizeRunLog(text: string): ProgressReport {
  const events: ProgressEvent[] = [];
  const stagesSeen = new Set<string>();
  const sectionKeys = new Set<string>();
  let sawSectionEvent = false;
  let sectionsTotal: number | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    const type = event.event_type;
    if (typeof type !== "string" || type === "") continue;

    // Type and timestamp ONLY. A run-log event also carries the rendered
    // system and user prompts, the raw model output and per-call token usage —
    // hundreds of kilobytes per run — and none of it belongs in a response
    // polled every few seconds.
    events.push({ type, at: typeof event.timestamp === "string" ? event.timestamp : null });

    if (PRELUDE_STAGE_SET.has(type)) stagesSeen.add(type);
    if (type === "plan.complete") {
      const total = countPlannedSections(event.raw_output);
      // Only overwrite on a plan that actually parsed: a retried
      // `plan.complete` whose payload is unreadable must not erase a total
      // an earlier, readable one already established.
      if (total !== null) sectionsTotal = total;
    }
    if (type === "section.generated") {
      sawSectionEvent = true;
      sectionKeys.add(sectionKeyFor(event, i));
    }
    if (type === "section.validated") sawSectionEvent = true;
  }

  return {
    stage: stageFor(stagesSeen, sawSectionEvent),
    stagesDone: stagesSeen.size,
    stagesTotal: PRELUDE_STAGES.length,
    sectionsGenerated: sectionKeys.size,
    sectionsTotal,
    events: events.slice(-MAX_PROGRESS_EVENTS),
  };
}

/**
 * The phase ladder, highest milestone first. A section event alone is enough
 * to say "generating sections" even with no `shell.complete` in the log: the
 * page workers run in parallel and a log read mid-write can legitimately show
 * a section before the stage that preceded it.
 */
function stageFor(stagesSeen: Set<string>, sawSectionEvent: boolean): string {
  if (sawSectionEvent || stagesSeen.has("shell.complete")) return PROGRESS_STAGES.sections;
  if (stagesSeen.has("primitives.complete")) return PROGRESS_STAGES.shell;
  if (stagesSeen.has("tokens.complete") || stagesSeen.has("plan.complete")) return PROGRESS_STAGES.design;
  if (stagesSeen.has("intake.complete")) return PROGRESS_STAGES.planning;
  return PROGRESS_STAGES.starting;
}

/**
 * Everything between a job row and a report: the `..` rail, the read, and the
 * "nothing yet" answer that three different absences share.
 */
export function readProgress(runlogDir: string, runId: string | null): ProgressReport {
  // A queued job, or one that has not reached `recordJobRun` yet.
  if (runId === null) return notStartedProgress();
  if (!isSafeRunId(runId)) {
    // Unreachable through any writer that exists today, so it is worth a log
    // line rather than a silent zero: it means a row was written by something
    // that skipped the rail. JSON.stringify'd, exactly as `recordJobRun` does
    // — the rejected value may contain newlines, and a raw splice into a log
    // line is how log injection starts.
    console.warn(`[progress-routes] refusing to read a run log for a run id of unsafe shape: ${JSON.stringify(runId)}`);
    return notStartedProgress();
  }
  let text: string;
  try {
    text = readFileSync(join(runlogDir, `${runId}.jsonl`), "utf8");
  } catch (err) {
    // ENOENT is the ordinary "the run has not logged anything yet" case and
    // must stay silent — it happens on every poll of a job that just started.
    // Anything else (EACCES, EISDIR) is a misconfiguration an operator needs
    // to see, but still answers 200 with zero counts: a progress read is
    // advisory, and failing it must never turn a healthy run into a reported
    // error.
    const code = (err as { code?: unknown }).code;
    if (code !== "ENOENT") {
      console.warn(`[progress-routes] could not read run log: ${String((err as { message?: unknown }).message ?? err)}`);
    }
    return notStartedProgress();
  }
  return summarizeRunLog(text);
}

export function progressRoutes(deps: { db: DatabaseSync; runlogDir?: string }): Route[] {
  const { db } = deps;
  // Resolved once per call, not per request: the directory is fixed for the
  // process's lifetime, and a test needs to be able to inject one.
  const runlogDir = deps.runlogDir ?? defaultRunlogDir();
  return [
    {
      method: "GET",
      path: "/api/jobs/:id/progress",
      handler: requireSession(db, (_req, res, ctx) => {
        const id = ctx.params.id;
        const job = id === undefined || id === "" ? null : findJobById(db, id);
        // ONE comparison, and the only one — copied in shape (and in its
        // shared NOT_FOUND constant) from job-routes.ts's GET /api/jobs/:id,
        // so a foreign job and an absent one are byte-identical answers.
        if (job === null || job.userId !== ctx.user.id) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        // The run id comes from the ROW. See this module's own top comment for
        // why there is deliberately no way for a client to supply one.
        sendJson(res, 200, readProgress(runlogDir, job.runId));
      }),
    },
  ];
}
