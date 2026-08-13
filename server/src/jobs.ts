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
// Type-only: the `provider` a job records is the same validated union a stored
// key carries, and `recordJobRun` refusing anything else at the type level is
// what keeps the column's CHECK (db.ts) a backstop rather than the only guard.
// A `import type` adds no runtime dependency, so this does not invert the
// layering `MAX_ACTIVE_JOBS_PER_USER`'s own comment protects.
import type { ApiKeyProvider } from "./api-keys.ts";

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
   * FIX ROUND B, I7. Which model provider this job's own (partial) execution
   * actually ran under — stamped by the same `recordJobRun` call as `runId` and
   * `codeVersion`, for the same reason, and never set at creation by any caller
   * including resume.
   *
   * The exact sibling of `codeVersion`: without it, replacing an Anthropic key
   * with a Gemini one between a failed job and its resume continues the same
   * `run_id` under a different model family, and Kitaru's cache (keyed on
   * function code plus args) leaves every completed checkpoint from the old
   * family in place — half-Anthropic, half-Gemini output. `job-routes.ts`'s
   * resume handler refuses 409 when this differs from the provider the account
   * uses now; `job-provider.ts` owns the comparison.
   *
   * A bare `string`, not `ApiKeyProvider`: this is what a row HOLDS, and a read
   * from a hand-editable column cannot be trusted the way `recordJobRun`'s own
   * validated input can (the same asymmetry `api-keys.ts` keeps between
   * `setApiKey`'s parameter and `providerOfRow`'s check). Null means no provider
   * was in play — either the job never reached `recordJobRun`, or it made no
   * model call at all (`export`).
   */
  provider: string | null;
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
  provider: string | null;
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
    provider: row.provider,
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
    // I7: never set at creation, by any caller including resume — the same rule
    // `codeVersion` above follows, and for the same reason (this records what
    // actually ran, and nothing has run yet). Listed in the INSERT explicitly
    // rather than left to the column's absence, so a DEFAULT added to the
    // migration later could not silently start claiming a provider for a job
    // that has not made a model call.
    provider: null,
    resumedFromJobId: input.resumedFromJobId ?? null,
  };
  db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at,
       run_id, code_version, provider, resumed_from_job_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    job.provider,
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

/**
 * Whether `jobId` already has an active (`queued` or `running`) resume
 * pointing back at it via `resumed_from_job_id` — task-7-review finding 8.
 * Without this, resuming the SAME failed job twice in a row (both attempts
 * pass the enqueue bound independently, since each is a fresh row) can put
 * two jobs running against the identical `run_id` at once: unlike Kitaru's
 * own checkpoint cache (built for a SEQUENTIAL resume, one attempt at a
 * time), two orchestrator invocations running CONCURRENTLY against one
 * project directory can race writing the same manifest/generated files — a
 * correctness hazard worse than the double-spend the enqueue bound alone
 * protects against. `job-routes.ts`'s resume handler calls this as a plain
 * read before its own bounded insert (see that call site's own comment for
 * why a plain read is sufficient in this handler's specific shape).
 */
export function hasActiveResumeFor(db: DatabaseSync, jobId: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS found FROM job WHERE resumed_from_job_id = ? AND status IN ('queued', 'running') LIMIT 1",
  ).get(jobId) as { found: number } | undefined;
  return row !== undefined;
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

/**
 * The `JobKind`s that spend NO model money but still take minutes and still
 * hold a preview slot — `export` is the only one today (a production build).
 * Named as its own set rather than derived as "everything not billable"
 * because `JobKind` also contains kinds that are neither: this list means
 * specifically "async, non-billable, and therefore bounded by
 * `MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER` rather than by the spend cap."
 */
export const NON_BILLABLE_ASYNC_JOB_KINDS: readonly JobKind[] = ["export"];

/**
 * The WHERE-clause-shaped fragment counting one user's active
 * (`queued`+`running`) jobs of a given kind set — a single,
 * scalar-subquery-ready expression (`?` for the user id, then one `?` per
 * kind, in that order). Built by a function so the billable and the
 * non-billable-async bounds are literally the same SQL shape rather than two
 * hand-written near-copies; the billable one is shared VERBATIM between
 * `countActiveBillableJobsForUser` below (a plain read) and
 * `createBillableJobIfUnderBound` below (the atomic gate), which is a task-3-
 * review-round-2 requirement after round 1 shipped a decorator
 * (`requireEnqueueSlot`, since deleted — see this module's own top comment)
 * whose read and whose write were two separate statements separated by an
 * `await`, which a concurrent burst of requests could all pass identically.
 */
function activeCountExprFor(kinds: readonly JobKind[]): string {
  const placeholders = kinds.map(() => "?").join(", ");
  return `(SELECT COUNT(*) FROM job WHERE user_id = ? AND status IN ('queued', 'running') AND kind IN (${placeholders}))`;
}

const ACTIVE_BILLABLE_COUNT_EXPR = activeCountExprFor(BILLABLE_JOB_KINDS);
const ACTIVE_NON_BILLABLE_ASYNC_COUNT_EXPR = activeCountExprFor(NON_BILLABLE_ASYNC_JOB_KINDS);

/**
 * WHOLE-BRANCH REVIEW, FINDING D — the largest `request_json` this table will
 * store.
 *
 * `enqueueHandler` persists `JSON.stringify(parsed)` of the whole request
 * body, and `router.ts`'s own `MAX_BODY_BYTES` allows 1,000,000 of them. That
 * cap exists to bound what a request may PARSE; it says nothing about what a
 * table may keep FOREVER, and `jobs.ts` has no retention or delete path at
 * all. An invited user looping `POST /__export?project=X` with 1 MB bodies
 * therefore grew the identity database without limit.
 *
 * 64 KiB is orders of magnitude above every real payload — `/__export` sends
 * `{}`, `/__regen` sends `{section, instruction}`, `/api/generate` sends one
 * brief — while being small enough that the growth rate is no longer the
 * problem. Deliberately NOT equal to `MAX_BODY_BYTES`: these bound different
 * things for different reasons, and pinning them equal (the way
 * `compiler/src/max-body-bytes.ts` is pinned to `router.ts`'s) would assert a
 * relationship that does not exist.
 */
export const MAX_REQUEST_JSON_BYTES = 64 * 1024;

/** True when `requestJson` may not be stored — see `MAX_REQUEST_JSON_BYTES`. Byte length, not `.length`: a multi-byte payload costs bytes on disk, not code units. */
export function requestJsonTooLarge(requestJson: string): boolean {
  return Buffer.byteLength(requestJson, "utf8") > MAX_REQUEST_JSON_BYTES;
}

/** The 413 body both enqueue sites send, shared verbatim so the wording and the number cannot drift — same rule `ENQUEUE_BOUND_REFUSED` follows. */
export const REQUEST_TOO_LARGE = {
  error: `a job's request body may be at most ${String(MAX_REQUEST_JSON_BYTES)} bytes`,
};

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
  return insertIfUnderBound(db, input, {
    countExpr: ACTIVE_BILLABLE_COUNT_EXPR,
    kinds: BILLABLE_JOB_KINDS,
    bound: MAX_ENQUEUED_BILLABLE_JOBS_PER_USER,
  });
}

/**
 * At most this many of one user's async, NON-billable jobs (`export`) may be
 * queued or running at once. Same value as the billable bound, for a
 * different reason: not spend, but that an unbounded queue of minutes-long
 * jobs is both a growth problem (`jobs.ts` has no retention path — see
 * `MAX_REQUEST_JSON_BYTES`) and a fairness one. FIFO means a user's own
 * hundred queued exports are claimed AHEAD of the regen they submit
 * afterwards, so the bound protects that user from themselves as much as it
 * protects the server.
 */
export const MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER = 2;

/** 429 for the same reason `ENQUEUE_BOUND_REFUSED` is: retrying genuinely helps once one finishes. Its own wording because it names a different bound over a different set of kinds. */
export const NON_BILLABLE_ENQUEUE_BOUND_REFUSED = {
  error: `at most ${String(MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER)} export jobs may be queued or running at once for this account; wait for one to finish and retry`,
};

/**
 * WHOLE-BRANCH REVIEW, FINDING D. `/__export` is `async: true, billable:
 * false`, so it took the plain `createJob` branch: no enqueue bound and no
 * cap. Combined with `enqueueHandler` persisting the whole request body and
 * `jobs.ts` having no retention path, an invited user could loop
 * `POST /__export?project=X` and grow the identity database without limit —
 * and, because claims are FIFO, have those queued exports served ahead of
 * their own later regens.
 *
 * The `billable: false` REASONING is untouched and must stay untouched: an
 * export spends no model money, so it is never refused over the SPEND cap
 * (`project-registry.ts`'s own comment — refusing an export over the cap
 * would strand a user's finished work behind a bill). This is a concurrency
 * bound, not a spend one; a user at it has two exports already in flight and
 * needs only to wait, which is why it answers 429.
 *
 * Same single `INSERT ... SELECT ... WHERE` atomicity as the billable gate —
 * literally the same helper — so a concurrent burst cannot all pass the same
 * pre-insert count.
 */
export function createNonBillableAsyncJobIfUnderBound(db: DatabaseSync, input: CreateJobInput): Job | null {
  if (!NON_BILLABLE_ASYNC_JOB_KINDS.includes(input.kind)) {
    throw new Error(
      `jobs.ts: createNonBillableAsyncJobIfUnderBound called with kind "${input.kind}", which is not an async non-billable kind`,
    );
  }
  return insertIfUnderBound(db, input, {
    countExpr: ACTIVE_NON_BILLABLE_ASYNC_COUNT_EXPR,
    kinds: NON_BILLABLE_ASYNC_JOB_KINDS,
    bound: MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER,
  });
}

/** The one conditional INSERT both bounded creators run. Not exported: a caller must go through one of the two kind-checked wrappers, so "which bound applies" is never a per-call-site decision. */
function insertIfUnderBound(
  db: DatabaseSync,
  input: CreateJobInput,
  gate: { countExpr: string; kinds: readonly JobKind[]; bound: number },
): Job | null {
  const id = randomUUID();
  const runId = input.runId ?? null;
  const resumedFromJobId = input.resumedFromJobId ?? null;
  const result = db.prepare(
    `INSERT INTO job (
       id, user_id, project_id, kind, status,
       request_json, result_json, error,
       created_at, started_at, finished_at,
       run_id, code_version, provider, resumed_from_job_id
     )
     SELECT ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL, ?
     WHERE ${gate.countExpr} < ?`,
  ).run(
    id, input.userId, input.projectId, input.kind, input.requestJson, input.now, runId, resumedFromJobId,
    input.userId, ...gate.kinds, gate.bound,
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
    // I7: null at creation, like `codeVersion` — see `createJob`'s own comment.
    provider: null,
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
 * Stamps `run_id` + `code_version` + `provider` on a job at the moment it
 * actually starts executing — called by `job-worker.ts` right after it resolves
 * the job's project, for BOTH execution strategies (`generate` and the five
 * proxied kinds). This is the ONLY place `code_version` is ever written: a fresh
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
 *
 * `provider` (I7) is REQUIRED rather than optional, and takes `null` explicitly
 * for a job that will make no model call: an optional field is exactly how one of
 * the two production call sites ends up not stating a provider, after which every
 * job that call site starts looks unguarded ("nothing ran") to the resume check.
 * A caller that genuinely has no provider must say so, in writing, per call.
 *
 * Throws (a programmer error, not a user-facing failure) if `input.runId`
 * fails `isSafeRunId` — task-7-review finding 5. Unreachable via any path
 * that exists today (`job-worker.ts` pre-checks the identical shape before
 * ever calling this, returning a normal failed `JobOutcome` instead of
 * reaching this throw), but `run_id` flows into a filesystem path
 * (`orchestrator.acceptance`'s `GENERATED_DIR / run_id`, `regen-api.ts`'s
 * `basename(root)`) — the identical shape the 4c-2 review found already
 * exploited once via an unvalidated `..`-bearing `route` field. This is the
 * seam a future caller (a request body, a script) would have to go through
 * instead of trusting one by convention.
 */
export function recordJobRun(
  db: DatabaseSync,
  id: string,
  input: { runId: string; codeVersion: string; provider: ApiKeyProvider | null },
): void {
  if (!isSafeRunId(input.runId)) {
    throw new Error(`jobs.ts: recordJobRun called with a runId of unsafe shape: ${JSON.stringify(input.runId)}`);
  }
  db.prepare("UPDATE job SET run_id = ?, code_version = ?, provider = ? WHERE id = ?")
    .run(input.runId, input.codeVersion, input.provider, id);
}

/**
 * A `run_id` shape safe to interpolate into a filesystem path — see
 * `recordJobRun`'s own comment for the concrete downstream call sites and
 * the precedent this guards against. Exported so `job-worker.ts` can check
 * BEFORE calling `recordJobRun`, turning an unsafe shape into a normal
 * failed job rather than an uncaught throw that would leave the job stuck
 * `running` forever (nothing downstream of a throw here would ever call
 * `finishJob`/`requeueJob` for it).
 *
 * The character class alone is NOT sufficient: `.` and `..` are both
 * spelled entirely out of allowed characters (dots), but as a WHOLE
 * segment either one means "this directory" or "the PARENT directory" to
 * `pathlib`'s `/` operator (`GENERATED_DIR / run_id`) and to `path.join`
 * alike — no `/` needs to appear anywhere in the string for `..` alone to
 * escape the intended directory. Caught by this module's own test suite
 * during task-7-review finding 5's fix, not assumed correct on the first
 * pass.
 */
export function isSafeRunId(id: string): boolean {
  if (id === "." || id === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
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
