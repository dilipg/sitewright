// server/src/jobs.ts
/**
 * Long-running work, tracked server-side so a disconnect never loses it.
 *
 * Slice 5's generation runs outlast a single HTTP request (measured ~286s
 * against a 5-minute target), and every existing `/__*` endpoint is
 * synchronous by decision 11. This table is the seam: a request enqueues a
 * job and returns immediately, a worker claims and runs it, and the browser
 * polls current state rather than trusting its own request's outcome (spec,
 * decision 13 — work in flight must survive a disconnect).
 *
 * This file is ONLY the table and its store — `job-worker.ts` (task 2) is
 * the worker that drains it, and it is the sole other module in `server/`
 * this one may depend on going the other way (job-worker.ts imports FROM
 * here, never the reverse) for the per-user concurrency bound
 * (`MAX_ACTIVE_JOBS_PER_USER`, enforced inside `claimNextJob` itself) and the
 * requeue path (`requeueJob`) a job takes when it was claimed but discovered,
 * only afterward, that it cannot run yet. Nothing enqueues onto this table
 * yet — that is a later task in the same slice.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type JobKind = "generate" | "regen" | "regen-page" | "add-section" | "edit-prompt" | "export";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface Job {
  id: string;
  userId: string;
  /** Null for work that belongs to no project yet (slice 5's first generation). */
  projectId: string | null;
  kind: JobKind;
  status: JobStatus;
  /**
   * A route, a section id, an instruction — whatever the triggering endpoint
   * needs to replay the work. NEVER an API key: the key lives server-side,
   * decrypted only at the point a job actually runs, never serialized into a
   * row a later listing endpoint could echo back to a browser.
   */
  requestJson: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * The Kitaru run id this job's own execution used. Null until
   * `recordJobRun` stamps it, at the moment `job-worker.ts` actually starts
   * running the job — NOT at enqueue, because the safety rail this exists
   * for (see `codeVersion`) cares what code ACTUALLY ran, and nothing has
   * run yet for a merely-queued job. Pre-populated at creation only for a
   * job made by `POST /api/jobs/:id/resume` (job-routes.ts), copied verbatim
   * from the job it resumes — every other creator leaves it null and lets
   * the worker derive+stamp it.
   */
  runId: string | null;
  /**
   * The server's own code version (server/src/code-version.ts) at the
   * moment THIS job started running — stamped by the same call as `runId`,
   * for the same reason, and NEVER set at creation (not even by resume):
   * this field records what code actually executed, and nothing has
   * executed yet for a job that only just got a row. docs/decisions.md's
   * 2026-07-28 row is why this exists: reusing a `runId` across a
   * source-code edit to a checkpoint function can silently skip a paired,
   * unchanged-code checkpoint's side effect — job-routes.ts's resume
   * handler refuses to resume when this differs from the current code
   * version.
   */
  codeVersion: string | null;
  /**
   * Set only on a job created by `POST /api/jobs/:id/resume` — the id of
   * the failed job it resumes. Null for every other job. The durable half
   * of "linked to the original, so the audit trail shows two attempts
   * rather than one mutated row" (task-7 brief).
   */
  resumedFromJobId: string | null;
}

interface Row {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  status: string;
  request_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  run_id: string | null;
  code_version: string | null;
  resumed_from_job_id: string | null;
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    requestJson: row.request_json,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    runId: row.run_id,
    codeVersion: row.code_version,
    resumedFromJobId: row.resumed_from_job_id,
  };
}

/**
 * At most this many of one user's jobs may be `running` at once — "today's
 * in-flight reservation, same value, same meaning" as `preview-pool.ts`'s
 * `MAX_BILLABLE_IN_FLIGHT_PER_USER`. Defined here independently rather than
 * imported: `jobs.ts` is the low-level table/store module every other
 * server/ module sits above (including, indirectly, `preview-pool.ts` via
 * `job-worker.ts`), so importing FROM `preview-pool.ts` here would invert
 * that dependency. Pinned equal to `MAX_BILLABLE_IN_FLIGHT_PER_USER` by a
 * test in jobs.test.ts — the same "two independent definitions, pinned
 * equal by a test" pattern `router.ts`'s `MAX_BODY_BYTES` and
 * `compiler/src/max-body-bytes.ts`'s own copy already use for the identical
 * reason.
 */
export const MAX_ACTIVE_JOBS_PER_USER = 2;

export interface CreateJobInput {
  userId: string;
  projectId: string | null;
  kind: JobKind;
  requestJson: string;
  now: number;
  /**
   * ONLY ever set by `job-routes.ts`'s `POST /api/jobs/:id/resume`, copying
   * the original failed job's own `runId` verbatim. Every other caller
   * omits this and the new job starts with `runId: null` — exactly the
   * pre-task-7 behaviour — and `job-worker.ts`'s `recordJobRun` fills it in
   * once the worker actually runs the job. Never `codeVersion`: that field
   * is never set at creation, by any caller, including resume — see `Job`'s
   * own doc comment for why.
   */
  runId?: string | null;
  /** ONLY ever set by the resume endpoint, naming the job being resumed. Every other caller omits it. */
  resumedFromJobId?: string | null;
}

export function createJob(db: DatabaseSync, input: CreateJobInput): Job {
  const job: Job = {
    id: randomUUID(),
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    status: "queued",
    requestJson: input.requestJson,
    resultJson: null,
    error: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
    runId: input.runId ?? null,
    codeVersion: null,
    resumedFromJobId: input.resumedFromJobId ?? null,
  };
  db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at,
       run_id, code_version, resumed_from_job_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.userId,
    job.projectId,
    job.kind,
    job.status,
    job.requestJson,
    job.resultJson,
    job.error,
    job.createdAt,
    job.startedAt,
    job.finishedAt,
    job.runId,
    job.codeVersion,
    job.resumedFromJobId,
  );
  return job;
}

export function findJobById(db: DatabaseSync, id: string): Job | null {
  const row = db.prepare("SELECT * FROM job WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toJob(row);
}

/** Most recent first — a project's job list is read as recent activity. */
export function listJobsByProject(db: DatabaseSync, projectId: string, limit: number): Job[] {
  return (
    db.prepare(
      "SELECT * FROM job WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(projectId, limit) as unknown as Row[]
  ).map(toJob);
}

/** `queued` + `running` — the spend cap's in-flight reservation reads this shape. */
export function countActiveJobsForUser(db: DatabaseSync, userId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM job WHERE user_id = ? AND status IN ('queued', 'running')",
  ).get(userId) as { count: number };
  return row.count;
}

/**
 * The `JobKind`s that spend model money — every kind except `export` (a
 * production build is deterministic and spends nothing, the same reasoning
 * `project-registry.ts`'s `billable: false` on `/__export` and
 * `/__export-download` already uses). Exported so callers gating enqueue on
 * billable work — `createBillableJobIfUnderBound` below, and `job-routes.ts`'s
 * `POST /api/generate` transaction — can filter by it without either module
 * re-deriving "which kinds are billable" from scratch or `jobs.ts` importing
 * anything billable-shaped from `project-registry.ts` (that registry is
 * about HTTP endpoints, not job rows, and importing it here would be the
 * wrong direction for the same layering reason `MAX_ACTIVE_JOBS_PER_USER`'s
 * own comment gives for not importing `preview-pool.ts`).
 */
export const BILLABLE_JOB_KINDS: readonly JobKind[] = ["generate", "regen", "regen-page", "add-section", "edit-prompt"];

const BILLABLE_KIND_PLACEHOLDERS = BILLABLE_JOB_KINDS.map(() => "?").join(", ");

/**
 * The WHERE-clause-shaped fragment counting one user's active
 * (`queued`+`running`) BILLABLE jobs — a single, scalar-subquery-ready
 * expression (`?` for the user id, then one `?` per `BILLABLE_JOB_KINDS`
 * entry, in that order), shared VERBATIM between `countActiveBillableJobsForUser`
 * below (a plain read) and `createBillableJobIfUnderBound` below (the atomic
 * gate). Defined exactly once so the two can never drift apart — a task-3-
 * review-round-2 requirement, after round 1 shipped a decorator
 * (`requireEnqueueSlot`, since deleted — see this module's own top comment)
 * whose read and whose write were two separate statements separated by an
 * `await`, which a concurrent burst of requests could all pass identically.
 */
const ACTIVE_BILLABLE_COUNT_EXPR =
  `(SELECT COUNT(*) FROM job WHERE user_id = ? AND status IN ('queued', 'running') AND kind IN (${BILLABLE_KIND_PLACEHOLDERS}))`;

/**
 * `queued` + `running` billable jobs only. NOT an authoritative gate on its
 * own — see `createBillableJobIfUnderBound` below for the one that is. This
 * is a plain read: useful for a status display, a test assertion, or (inside
 * `job-routes.ts`'s `POST /api/generate`) a count taken INSIDE an already-open
 * `BEGIN IMMEDIATE` transaction, where the surrounding transaction — not this
 * function — is what makes the read-then-write atomic. Called with no
 * transaction of its own around it, this function's result can be stale by
 * the time a caller acts on it; that is exactly the bug task-3-review round 2
 * found in the deleted `requireEnqueueSlot`, which called this, then
 * `createJob`, with an `await` in between.
 *
 * Distinct from `countActiveJobsForUser` in TWO ways, not one: it excludes
 * `export` (spends nothing, must never be refused or counted — see
 * `BILLABLE_JOB_KINDS`), and its counterpart bound is evaluated at ENQUEUE
 * time, before a job row even exists yet, rather than at claim time the way
 * `claimNextJob`'s own running-only bound is.
 */
export function countActiveBillableJobsForUser(db: DatabaseSync, userId: string): number {
  const row = db.prepare(`SELECT ${ACTIVE_BILLABLE_COUNT_EXPR} AS count`)
    .get(userId, ...BILLABLE_JOB_KINDS) as { count: number };
  return row.count;
}

/**
 * The enqueue-time bound on committed BILLABLE work — "Per user: 2
 * concurrent — today's in-flight reservation, unchanged in value and
 * meaning" (spec, job-model design doc). Defined here, independently of
 * `MAX_ACTIVE_JOBS_PER_USER` above (a different bound: running-only, every
 * kind, enforced at claim time) and of `preview-pool.ts`'s
 * `MAX_BILLABLE_IN_FLIGHT_PER_USER` (an in-memory, per-process reservation
 * this bound replaces), for the identical layering reason
 * `MAX_ACTIVE_JOBS_PER_USER`'s own comment gives. Pinned equal to both by a
 * test in jobs.test.ts.
 */
export const MAX_ENQUEUED_BILLABLE_JOBS_PER_USER = 2;

/**
 * The 429 body every enqueue-bound refusal sends — `compiler-routes.ts`'s
 * `enqueueHandler` and `job-routes.ts`'s `POST /api/generate` transaction
 * both import this rather than each writing their own copy of a message that
 * NAMES `MAX_ENQUEUED_BILLABLE_JOBS_PER_USER`, so the wording and the number
 * cannot drift apart between the two call sites. 429, not 402: retrying
 * genuinely helps here once an in-flight job finishes, unlike the spend
 * cap's 402 where no amount of retrying helps until the window rolls.
 */
export const ENQUEUE_BOUND_REFUSED = {
  error: `at most ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER)} billable jobs may be queued or running at once for this account; wait for one to finish and retry`,
};

/**
 * Atomically inserts a `queued` job for a BILLABLE kind, but ONLY if doing so
 * would not push the user's `queued`+`running` billable job count to or past
 * `MAX_ENQUEUED_BILLABLE_JOBS_PER_USER` — one `INSERT ... SELECT ... WHERE`
 * statement, not a `countActiveBillableJobsForUser` read followed by a
 * separate `createJob` write. Returns `null` (zero rows inserted, verified
 * via `result.changes`) when the user is at the bound; the caller maps that
 * to 429. Returns the inserted `Job` otherwise.
 *
 * THIS is task-3-review round 2's actual fix, not a decoration around it:
 * `claimNextJob`'s own doc comment states the rule this function follows —
 * "This MUST be a single statement, not a SELECT followed by an UPDATE: a
 * second caller could observe the same row between those two steps." A
 * single `INSERT ... SELECT ... WHERE` is what SQLite executes as one
 * atomic operation; a second concurrent caller's insert simply matches zero
 * rows (the `WHERE` re-evaluates against the NEW count including the first
 * caller's row) once the first has already landed, no transaction or
 * app-level lock needed — the exact pattern `claimNextJob` already uses for
 * its own per-user bound, applied here to a conditional INSERT instead of a
 * conditional UPDATE.
 *
 * Deliberately throws (a programmer error, not a user-facing failure) if
 * `input.kind` is not one of `BILLABLE_JOB_KINDS` — calling this for
 * `export` would incorrectly gate a job that must never be refused or
 * counted (see `BILLABLE_JOB_KINDS`'s own comment); a caller that wants an
 * unconditional insert for a non-billable kind should call `createJob`
 * directly, exactly as `compiler-routes.ts`'s `enqueueHandler` does.
 */
export function createBillableJobIfUnderBound(db: DatabaseSync, input: CreateJobInput): Job | null {
  if (!BILLABLE_JOB_KINDS.includes(input.kind)) {
    throw new Error(`jobs.ts: createBillableJobIfUnderBound called with non-billable kind "${input.kind}"`);
  }
  const id = randomUUID();
  const runId = input.runId ?? null;
  const resumedFromJobId = input.resumedFromJobId ?? null;
  const result = db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at,
       run_id, code_version, resumed_from_job_id
     )
     SELECT ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, NULL, NULL, ?, NULL, ?
     WHERE ${ACTIVE_BILLABLE_COUNT_EXPR} < ?`,
  ).run(
    id, input.userId, input.projectId, input.kind, input.requestJson, input.now, runId, resumedFromJobId,
    input.userId, ...BILLABLE_JOB_KINDS, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER,
  );
  if (Number(result.changes) === 0) return null;
  return {
    id,
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    status: "queued",
    requestJson: input.requestJson,
    resultJson: null,
    error: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
    runId,
    codeVersion: null,
    resumedFromJobId,
  };
}

/**
 * Atomically claims the oldest ELIGIBLE `queued` job and flips it to
 * `running`, or returns null if none is eligible. Eligible means: `queued`,
 * AND its user does not already have `MAX_ACTIVE_JOBS_PER_USER` jobs
 * `running`. A user at their limit is skipped entirely, not claimed and
 * handed back for the caller to undo — their oldest queued job simply is
 * not selected this call, so it remains at the front of the queue for
 * THEIR next eligible claim, while jobs behind it for OTHER users remain
 * reachable. (An earlier version of this function claimed unconditionally
 * and relied on the caller to requeue a job it turned out could not run;
 * that starved every other user behind a chronically-blocked one, since a
 * requeued job's `created_at` is unchanged and it was always claimed again
 * first. Pushing the bound into the selection itself is what fixes that.)
 *
 * This MUST be a single statement, not a SELECT followed by an UPDATE: a
 * second caller (a test, a future second worker) could observe the same
 * `queued` row between those two steps and claim it too. A single UPDATE
 * whose WHERE still tests `status = 'queued'` is what SQLite itself executes
 * as one atomic operation — the second concurrent caller's UPDATE simply
 * matches zero rows once the first has already flipped the status, no
 * transaction or app-level lock needed. RETURNING hands back the row that
 * was actually changed, so a caller never has to guess which id "won". The
 * eligibility subquery lives INSIDE this same statement for the same
 * reason: computing "who is at their limit" as a separate read, then
 * claiming by id, would reopen exactly the race a single UPDATE exists to
 * close (the running count could change between the read and the claim).
 *
 * Deliberately counts `status = 'running'` only, not `countActiveJobsForUser`'s
 * `queued` + `running` — a user with several jobs merely QUEUED (not yet
 * started) must not be blocked from starting the first of them; only
 * currently-RUNNING work should count against this bound. Using the
 * queued+running count here would claim-then-immediately-be-over-the-bound
 * for that user's very first job the moment they have two or more others
 * waiting behind it — worked through by hand while building this: a user
 * with 3 jobs all `queued` has `countActiveJobsForUser` = 3 before any of
 * them ever runs, which would permanently block that user's queue rather
 * than merely bound their concurrency.
 */
export function claimNextJob(db: DatabaseSync, now: number): Job | null {
  const row = db.prepare(
    `UPDATE job SET status = 'running', started_at = ?
       WHERE id = (
         SELECT id FROM job
          WHERE status = 'queued'
            AND user_id NOT IN (
              SELECT user_id FROM job
               WHERE status = 'running'
               GROUP BY user_id
              HAVING COUNT(*) >= ?
            )
          ORDER BY created_at ASC, rowid ASC LIMIT 1
       )
       AND status = 'queued'
     RETURNING *`,
  ).get(now, MAX_ACTIVE_JOBS_PER_USER) as Row | undefined;
  return row === undefined ? null : toJob(row);
}

/**
 * Returns a claimed (`running`) job to `queued` — for the ONE case
 * `claimNextJob`'s own eligibility check cannot see in advance: the preview
 * pool's global capacity (shared with non-job preview traffic), discovered
 * only after a job is already claimed and its proxy exchange has been
 * attempted. Distinct from `finishJob` deliberately: a requeued job has NOT
 * finished, so `finished_at` must stay null, which `finishJob` cannot do (it
 * stamps `finished_at` unconditionally — correct for its actual terminal
 * statuses, wrong for `queued`). `started_at` is cleared too, so a requeued
 * job looks exactly like one that was never claimed at all.
 */
export function requeueJob(db: DatabaseSync, id: string): void {
  db.prepare(
    "UPDATE job SET status = 'queued', started_at = NULL WHERE id = ?",
  ).run(id);
}

/**
 * The three statuses a job can actually FINISH in. `queued` and `running`
 * are deliberately excluded from `FinishJobInput.status` below — a compile-
 * time guard, not just a convention, against ever stamping `finished_at` on
 * a job that has not finished (see `requeueJob`, the correct primitive for
 * "back to queued").
 */
export type TerminalJobStatus = "succeeded" | "failed" | "interrupted";

export interface FinishJobInput {
  status: TerminalJobStatus;
  resultJson?: string | null;
  error?: string | null;
  now: number;
}

export function finishJob(db: DatabaseSync, id: string, input: FinishJobInput): void {
  db.prepare(
    "UPDATE job SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?",
  ).run(input.status, input.resultJson ?? null, input.error ?? null, input.now, id);
}

/**
 * Stamps `run_id` + `code_version` on a job at the moment it actually starts
 * executing — called by `job-worker.ts` right after it resolves the job's
 * project, for BOTH execution strategies (`generate` and the five proxied
 * kinds). This is the ONLY place `code_version` is ever written: a fresh
 * (non-resume) job starts with it null (neither `createJob` nor
 * `createBillableJobIfUnderBound` above ever set it), and it earns a value
 * only once real work actually begins under it — matching the safety rule
 * this exists for (docs/decisions.md, 2026-07-28): `code_version` records
 * what code ACTUALLY RAN, never what code merely existed when the job was
 * enqueued.
 *
 * `run_id` may already be set (a job created by resume carries one from
 * creation, copied from the job it resumes) — this overwrites it with the
 * SAME value regardless (job-worker.ts passes `job.runId ?? project.directory`,
 * so a resumed job's own already-correct value round-trips unchanged), which
 * keeps this function's contract simple ("this is what actually ran") rather
 * than conditional on whether a value was already present.
 */
export function recordJobRun(db: DatabaseSync, id: string, input: { runId: string; codeVersion: string }): void {
  db.prepare("UPDATE job SET run_id = ?, code_version = ? WHERE id = ?").run(input.runId, input.codeVersion, id);
}

/**
 * Boot recovery: a job left `running` when the process died (crash, deploy,
 * kill -9) is not actually running anymore, and nothing will ever claim or
 * finish it again. Converting it to a terminal `interrupted` status is what
 * lets a poller stop waiting on it instead of hanging forever. Returns how
 * many rows were converted, for a boot log line.
 */
export function markRunningJobsInterrupted(db: DatabaseSync, now: number): number {
  const result = db.prepare(
    "UPDATE job SET status = 'interrupted', finished_at = ? WHERE status = 'running'",
  ).run(now);
  return Number(result.changes);
}
