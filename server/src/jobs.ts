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
  };
  db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
 * `/__export-download` already uses). Exported so `require-enqueue-slot.ts`
 * — the enqueue-time concurrency bound on billable work, not this file's own
 * concern — can filter by it without either module re-deriving "which kinds
 * are billable" from scratch or `jobs.ts` importing anything billable-shaped
 * from `project-registry.ts` (that registry is about HTTP endpoints, not job
 * rows, and importing it here would be the wrong direction for the same
 * layering reason `MAX_ACTIVE_JOBS_PER_USER`'s own comment gives for not
 * importing `preview-pool.ts`).
 */
export const BILLABLE_JOB_KINDS: readonly JobKind[] = ["generate", "regen", "regen-page", "add-section", "edit-prompt"];

/**
 * `queued` + `running` billable jobs only — the metric `require-enqueue-slot.ts`
 * gates enqueue on. Distinct from `countActiveJobsForUser` in TWO ways, not
 * one: it excludes `export` (spends nothing, must never be refused or
 * counted — see `BILLABLE_JOB_KINDS`), and its counterpart bound is
 * evaluated at ENQUEUE time, before a job row even exists yet, rather than at
 * claim time the way `claimNextJob`'s own running-only bound is. Because this
 * is a live COUNT against `queued`+`running` rows rather than an in-memory
 * reservation, a slot frees itself the instant `finishJob` moves a row to a
 * terminal status — there is no separate "release" call to remember, unlike
 * the old `PreviewPool.reserveBillableSlot`/`releaseBillableSlot` pair this
 * replaces (see `require-enqueue-slot.ts`'s own module comment for the full
 * account of why that in-memory mechanism stopped bounding anything once
 * enqueuing became a single fast INSERT).
 */
export function countActiveBillableJobsForUser(db: DatabaseSync, userId: string): number {
  const placeholders = BILLABLE_JOB_KINDS.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM job
      WHERE user_id = ? AND status IN ('queued', 'running') AND kind IN (${placeholders})`,
  ).get(userId, ...BILLABLE_JOB_KINDS) as { count: number };
  return row.count;
}

/**
 * The enqueue-time bound `require-enqueue-slot.ts` refuses past — "Per user:
 * 2 concurrent — today's in-flight reservation, unchanged in value and
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
