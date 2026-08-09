// server/src/job-routes.ts
/**
 * Web-triggered generation, and job status (slice 5).
 *
 * `POST /api/generate` is the first route in this codebase that CREATES a
 * project — every prior slice's "no route creates a project" was true only
 * because nothing had triggered generation from the web yet (project-routes.ts's
 * own module comment says so explicitly). It is not a route that creates a
 * USER, and never will be: `server/src/user-cli.ts` stays the only path to an
 * account (spec, threat model; CLAUDE.md's ownership rule for `server/`).
 *
 * Per the resolved job-model design (docs/superpowers/specs/
 * 2026-08-06-job-model-design.md, "Resolved: the project row is created at
 * enqueue"): the project row AND its on-disk directory are created here,
 * synchronously, before the job is ever queued. A failed generation therefore
 * leaves an owned, visible, deletable project rather than an orphaned
 * directory nobody's account points at — the exact problem slice 4a's
 * adoption pass had to clean up once already for acceptance runs made before
 * any of this existed. The consequence, stated in the same design doc and
 * repeated in CLAUDE.md, is binding on the rest of this codebase too: a
 * project can now exist with an empty directory until the `generate` job
 * actually runs.
 *
 * `GET /api/jobs/:id` is deliberately NOT wrapped in `requireProject`: a job
 * belongs to the USER who queued it (`job.user_id`), not to a project, and a
 * generation job's `project_id` survives even if that project is later
 * deleted (`ON DELETE SET NULL`, jobs.ts's own schema comment) — a
 * requireProject-shaped check would have nothing left to compare against for
 * exactly the jobs most worth still being able to look up. The 404 for a
 * foreign or absent job reuses require-project.ts's own `NOT_FOUND` constant
 * verbatim (not a differently-worded copy) so the two responses are
 * byte-identical and a job id is exactly as useless an oracle as a project id
 * already is.
 *
 * `GET /api/jobs?project=<id>` IS project-scoped (a project's own recent
 * activity), so it goes through `requireProject` like any other project-owned
 * resource.
 *
 * `POST /api/generate`'s enqueue bound (task-3-review round 2): a plain
 * `countActiveBillableJobsForUser` read followed by separate `createProject`/
 * `createJob` writes — this module's round-1 shape — is not atomic: a burst
 * of concurrent requests can all read the same pre-insert count before any
 * of them writes (proven empirically, 10 concurrent requests for one user
 * all producing 202 against a bound of 2). `compiler-routes.ts`'s five
 * proxied kinds close this with one atomic `INSERT ... SELECT ... WHERE`
 * (`jobs.ts`'s `createBillableJobIfUnderBound`), but that alone is too late
 * here: `POST /api/generate` also creates a PROJECT row and a directory, and
 * both precede the job insert, so a request that is refused at the job
 * insert would already have created a project and a directory nobody's
 * account should keep. This module instead wraps the count check AND both
 * inserts in one real `BEGIN IMMEDIATE` transaction (the idiom already used
 * by `db.test.ts`'s cross-connection lock test, so it is proven to work with
 * `node:sqlite`): `mkdirSync` runs OUTSIDE the transaction and first (a
 * throw there must leave no rows at all, preserving the mkdir-then-row
 * ordering fixed in an earlier review round), then the transaction opens,
 * reads the count, and EITHER rolls back and best-effort removes the
 * directory (over the bound) OR inserts both rows and commits (under it) —
 * never partially. `BEGIN IMMEDIATE` takes SQLite's write lock up front, so
 * a second real connection attempting a write while this transaction is open
 * waits on `busy_timeout` rather than interleaving.
 *
 * An honest note on WHERE the concurrent-request race this fixes actually
 * gets closed, checked by experiment rather than assumed: this server runs
 * one process holding one `DatabaseSync` connection shared by every request,
 * and `node:sqlite`'s calls are fully synchronous — so, in THIS architecture,
 * the property that actually stops N concurrently-fired requests from all
 * reading the same pre-insert count is that there is no `await` anywhere
 * between the count check and `COMMIT` (JS cannot preempt a synchronous
 * stack to run a second request's continuation in the middle of one). Undoing
 * only `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` (turning them into no-ops, and
 * nothing else) while leaving that synchronous count-check-then-insert shape
 * intact was tried, and the concurrent test below still passed — so
 * `BEGIN IMMEDIATE` is not, by itself, why the test in THIS process passes.
 * It is kept anyway, deliberately, for two reasons this experiment does not
 * touch: it gives the count-check-and-two-inserts sequence real transactional
 * atomicity against an unanticipated mid-sequence error (the `catch` block
 * below), and it is what would actually serialize a SECOND real connection
 * (a future second server process, a migration script run concurrently) —
 * exactly the property `db.test.ts`'s own cross-connection lock test proves,
 * which this single-process test suite structurally cannot exercise for this
 * code path.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { codeVersionsIncompatible, resolveCodeVersion } from "./code-version.ts";
import {
  BILLABLE_JOB_KINDS, countActiveBillableJobsForUser, createBillableJobIfUnderBound, createJob,
  createNonBillableAsyncJobIfUnderBound, ENQUEUE_BOUND_REFUSED, findJobById, hasActiveResumeFor,
  listJobsByProject, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER, NON_BILLABLE_ENQUEUE_BOUND_REFUSED,
  REQUEST_TOO_LARGE, requestJsonTooLarge, type Job,
} from "./jobs.ts";
import { BY_QUERY } from "./project-registry.ts";
import { createProject, resolveProjectDirectory } from "./projects.ts";
import { requireBudget } from "./require-budget.ts";
import { NOT_FOUND, requireProject } from "./require-project.ts";
import { requireSession } from "./require-session.ts";
import { readJsonBody, sendJson, type Route } from "./router.ts";
import { checkSpendCap, describeSpendCap } from "./spend-cap.ts";

/** Most recent jobs shown for one project's activity — bounded so a project with a long history is not a full-table read on every poll. */
const PROJECT_JOB_LIST_LIMIT = 50;

const BAD_BRIEF = { error: "a brief is required" };
/** Same shape router.ts's own readJsonBody-failure responses use elsewhere (compiler-routes.ts's enqueueHandler) — a malformed body is a body problem, not a missing-field problem, and deserves its own message rather than being folded into BAD_BRIEF. */
const BAD_JSON_BODY = { error: "request body must be valid JSON within the size limit" };

/**
 * A directory name unique enough that `createProject`'s own UNIQUE
 * constraint on `directory` is never realistically the source of a failure —
 * a v4 UUID, not a counter or a slug derived from the brief (which could
 * collide trivially: two users typing the same one-line brief is the common
 * case this product exists for, not the rare one).
 */
function freshProjectDirectory(): string {
  return `web-${randomUUID()}`;
}

/**
 * The client-facing view of a job — an explicit field list, never the raw
 * row: `request_json` is the internal replay payload (never containing an
 * API key, per jobs.ts's own doc comment, but still not something a status
 * poll needs to echo back), and `result`/`error` are surfaced under their own
 * keys, present only when the job has actually reached that state, matching
 * the design doc's own `{ status, kind, createdAt, finishedAt, result?,
 * error? }` shape (id and projectId added: `GET /api/jobs?project=` returns
 * several of these at once, and a caller needs the id to tell them apart).
 *
 * `result_json` is itself a JSON string (the child's own response body, or
 * `generate`'s own `{stdout}` wrapper) — parsed here so a poller gets a
 * structured object rather than a double-encoded string. A parse failure
 * (defensive only; nothing in this codebase writes a non-JSON resultJson
 * today) falls back to the raw string rather than dropping the field or
 * throwing, since SOME evidence of what finished is better than a 500 on a
 * status poll.
 */
function publicJobView(job: Job): Record<string, unknown> {
  let result: unknown;
  if (job.resultJson !== null) {
    try {
      result = JSON.parse(job.resultJson);
    } catch {
      result = job.resultJson;
    }
  }
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(result !== undefined ? { result } : {}),
    ...(job.error !== null ? { error: job.error } : {}),
  };
}

/** "resume of a non-failed job is refused" (task-7 brief) — 409, the standard code for "this request conflicts with the resource's current state," the same reasoning `CODE_VERSION_MISMATCH` below uses for the other resume-specific conflict. */
const NOT_FAILED = { error: "only a failed job can be resumed" };

/**
 * The safety rule (docs/decisions.md, 2026-07-28 row; task-7 brief): a job
 * whose recorded `code_version` differs from the server's CURRENT one must
 * never be resumed — the server may have edited a checkpoint's body since
 * this job's own (partial) execution, and Kitaru's cache keys on function
 * code plus args, so an unchanged-code checkpoint downstream would silently
 * skip its side effect while the changed one re-executes. No SHA is echoed
 * back: the client does not need one to act correctly (the fix is always
 * "start a fresh job"), and there is no reason to hand out server build
 * identifiers to a caller who does not need them.
 */
const CODE_VERSION_MISMATCH = {
  error: "the server code has changed since this job ran; it cannot be resumed — start a fresh job instead",
};

/**
 * Task-7-review finding 8: nothing else stops a user resuming the SAME
 * failed job twice in a row — the original stays `failed` (resuming does
 * not change it), so a second `POST .../resume` before the first resume
 * finishes passes every other check identically and enqueues a SECOND job
 * against the identical `run_id`. Unlike Kitaru's own checkpoint cache
 * (built for a SEQUENTIAL resume, one attempt at a time), two orchestrator
 * invocations running CONCURRENTLY against one project directory can race
 * writing the same manifest/generated files — a correctness hazard worse
 * than the double-spend the enqueue bound alone protects against.
 */
const ALREADY_RESUMING = { error: "this job already has a resume queued or running" };

export function jobRoutes(deps: { db: DatabaseSync; projectsRoot: string; codeVersion?: string }): Route[] {
  const { db, projectsRoot } = deps;
  // Computed once per `jobRoutes()` call (itself normally called once at
  // boot, from scripts/serve.ts) rather than per request — the whole point
  // is ONE stable value compared against every job's own stamp
  // (job-worker.ts's `recordJobRun` uses the SAME default when a caller
  // omits its own `codeVersion`, so the common case — nobody threading an
  // explicit value through — still agrees).
  const codeVersion = deps.codeVersion ?? resolveCodeVersion();

  return [
    {
      method: "POST",
      path: "/api/generate",
      // requireBudget runs BEFORE any body is read or any project/job row is
      // created — an over-cap request is refused with no side effect at all,
      // matching the binding constraint that the spend cap gates enqueue and
      // an over-cap request creates no job row (and, here, no project row
      // either). The enqueue-time CONCURRENCY bound (as opposed to the spend
      // cap) is enforced further down, inside the transaction — see this
      // module's own top comment for why it can no longer be a wrapper here.
      handler: requireSession(db, requireBudget(db, async (req, res, ctx) => {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req);
        } catch {
          sendJson(res, 400, BAD_JSON_BODY);
          return;
        }
        const brief =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).brief
            : undefined;
        if (typeof brief !== "string" || brief.trim() === "") {
          sendJson(res, 400, BAD_BRIEF);
          return;
        }
        const trimmedBrief = brief.trim();
        const requestJson = JSON.stringify({ brief: trimmedBrief });
        // Whole-branch review, FINDING D: the same ceiling `enqueueHandler`
        // applies, checked here too because this endpoint builds its own
        // `request_json` rather than going through that handler. Before the
        // directory is created and before the transaction opens, so an
        // over-sized brief leaves no row and no directory.
        if (requestJsonTooLarge(requestJson)) {
          sendJson(res, 413, REQUEST_TOO_LARGE);
          return;
        }

        // Directory FIRST, OUTSIDE the transaction: if mkdirSync throws
        // (ENOSPC, EACCES, ...) there must be no row left pointing at a
        // directory that was never actually created, and there is nothing
        // yet to roll back (no transaction has opened). The reverse order's
        // failure mode is worse than this one's — a harmless orphan
        // directory with no owning row, vs. an owned row whose directory
        // silently does not exist.
        const directory = freshProjectDirectory();
        const resolvedDir = resolveProjectDirectory(projectsRoot, directory);
        mkdirSync(resolvedDir, { recursive: true });

        // ONE real transaction from here on: the count check and BOTH
        // inserts (project, then job) happen inside it, so a concurrent
        // burst of requests cannot all read the same pre-insert count the
        // way task-3-review round 2 proved a plain read-then-write could.
        // `BEGIN IMMEDIATE` (not the bare `BEGIN` SQLite defaults to) takes
        // the write lock up front rather than on the transaction's first
        // write, so a second real connection's own transaction waits on
        // `busy_timeout` instead of interleaving with this one.
        db.exec("BEGIN IMMEDIATE");
        try {
          if (countActiveBillableJobsForUser(db, ctx.user.id) >= MAX_ENQUEUED_BILLABLE_JOBS_PER_USER) {
            db.exec("ROLLBACK");
            try {
              rmSync(resolvedDir, { recursive: true, force: true });
            } catch {
              // Best-effort only: an orphan directory with no owning row is
              // the same harmless leftover mkdirSync's own ordering comment
              // above already accepts, not a correctness problem.
            }
            sendJson(res, 429, ENQUEUE_BOUND_REFUSED);
            return;
          }

          // Project row AND directory together, before the job is ever
          // queued — see this module's own top comment for why. The name is
          // the brief itself (truncated): the only user-facing label
          // available at this point, and the same thing adopt.ts falls back
          // to when nothing better exists.
          const project = createProject(db, ctx.user.id, directory, trimmedBrief.slice(0, 200));
          const job = createJob(db, {
            userId: ctx.user.id,
            projectId: project.id,
            kind: "generate",
            requestJson,
            now: Date.now(),
          });
          db.exec("COMMIT");
          sendJson(res, 202, { jobId: job.id, projectId: project.id });
        } catch (err) {
          // Defence in depth against an error this handler did not
          // anticipate (e.g. a UNIQUE collision): `db` is ONE connection
          // shared by every request this process serves, so leaving a
          // transaction open here would corrupt every OTHER request's
          // writes, not just this one's. Roll back, best-effort clean up the
          // directory, then rethrow — the router's own top-level catch maps
          // this to a generic 500, same as any other unanticipated failure.
          try {
            db.exec("ROLLBACK");
          } catch {
            // Nothing open (already rolled back or never began) — fine.
          }
          try {
            rmSync(resolvedDir, { recursive: true, force: true });
          } catch {
            // Best-effort only.
          }
          throw err;
        }
      })),
    },
    {
      method: "GET",
      path: "/api/jobs/:id",
      handler: requireSession(db, (_req, res, ctx) => {
        const id = ctx.params.id;
        const job = id === undefined || id === "" ? null : findJobById(db, id);
        // One comparison, and the only one — mirrors requireProject's own
        // "a missing row and a foreign row collapse into the same branch."
        if (job === null || job.userId !== ctx.user.id) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        sendJson(res, 200, publicJobView(job));
      }),
    },
    {
      method: "POST",
      path: "/api/jobs/:id/resume",
      // Session-only, exactly like GET /api/jobs/:id above and for the
      // identical reason (ownership is on the job's own user_id, not via
      // requireProject — a generation job's project_id can go NULL if its
      // project is later deleted). NOT wrapped in requireBudget: whether
      // this request spends anything at all depends on the LOOKED-UP job's
      // own kind (export never does), which is not known until after the
      // lookup — requireBudget's own composition shapes both assume the cap
      // applies unconditionally to every request an entry receives. The cap
      // is instead checked by hand, below, only for a billable kind — see
      // project-registry.ts's own entry for why this is `billable: false`
      // at the registry level despite conditionally gating a real charge.
      handler: requireSession(db, (_req, res, ctx) => {
        const id = ctx.params.id;
        const original = id === undefined || id === "" ? null : findJobById(db, id);
        // Same one comparison, same ordering, as GET /api/jobs/:id above —
        // a foreign job and an absent one must answer byte-identically.
        if (original === null || original.userId !== ctx.user.id) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        if (original.status !== "failed") {
          sendJson(res, 409, NOT_FAILED);
          return;
        }
        // The safety rule. codeVersionsIncompatible (code-version.ts) is the
        // ONE comparison point — never a bare `!==` here, since two
        // DIFFERENT boots that both fail to determine a version produce the
        // identical `UNKNOWN_CODE_VERSION` string (task-7-review finding 1;
        // see that function's own comment for the full account). A null
        // `original.codeVersion` means the original job never reached
        // job-worker.ts's recordJobRun at all (it failed before any real
        // execution began — a malformed payload, a since-deleted project,
        // ...) — nothing ran, so there is no stale-checkpoint risk to guard
        // against, and resuming is exactly equivalent to a fresh attempt
        // either way; `codeVersionsIncompatible` returns `false` for that
        // case regardless of the server's own current value.
        if (codeVersionsIncompatible(original.codeVersion, codeVersion)) {
          sendJson(res, 409, CODE_VERSION_MISMATCH);
          return;
        }

        // Task-7-review finding 8: refuse a SECOND concurrent resume of the
        // same original job — see ALREADY_RESUMING's own comment for why
        // this is a data-integrity guard, not merely a spend one. A plain
        // read (not folded into the atomic insert below): this handler has
        // no internal `await` anywhere (same property finding 6's own
        // comment on the enqueue bound documents), so in THIS single-process
        // architecture a second concurrent request cannot observe a
        // different answer from this query before the first request's own
        // insert has already landed — the identical reasoning, applied here
        // rather than re-derived.
        if (hasActiveResumeFor(db, original.id)) {
          sendJson(res, 409, ALREADY_RESUMING);
          return;
        }

        const now = Date.now();
        const input = {
          userId: ctx.user.id,
          projectId: original.projectId,
          kind: original.kind,
          requestJson: original.requestJson,
          now,
          // Carried forward verbatim, per the brief: "enqueues a new job row
          // carrying the same run_id, linked to the original."
          runId: original.runId,
          resumedFromJobId: original.id,
        };

        if (BILLABLE_JOB_KINDS.includes(original.kind)) {
          // Re-checked at enqueue, exactly as for a first attempt (task-7
          // brief) — the same read requireBudget itself performs, just
          // applied conditionally here since not every resumable kind is
          // billable (export is not, and must never be capped — see
          // project-registry.ts's own `/__export` reasoning).
          const spend = checkSpendCap(db, ctx.user, now);
          if (!spend.allowed) {
            sendJson(res, 402, {
              error: describeSpendCap(spend),
              capUsd: spend.capUsd,
              spentUsd: spend.spentUsd,
              resetAt: spend.resetAt,
            });
            return;
          }
          // THE bounded insert — the same single atomic INSERT ... SELECT
          // ... WHERE `POST /api/generate` and every proxied kind's own
          // enqueueHandler use, never a separate count-then-insert. Skipping
          // this in favour of plain `createJob` is exactly the task-3-review
          // round-1 mistake this task's own brief calls out by name: a burst
          // of concurrent resumes for one user must never all pass the SAME
          // pre-insert count, on precisely the endpoint most likely to be
          // hammered (a user retrying a failure).
          //
          // What actually MAKES this atomic is SQLite itself: one
          // `INSERT ... SELECT ... WHERE` is executed as a single indivisible
          // operation against the database file — an engine guarantee that
          // holds regardless of caller shape. Task-7-review finding 6
          // (correcting an earlier, circular version of this comment): that
          // guarantee is NOT proven by job-routes.test.ts's own concurrent
          // test for this endpoint (this handler has no internal `await`, so
          // nothing here interleaves within one test process either way —
          // see that test's own comment), nor by jobs.test.ts's "TRULY
          // CONCURRENT" test for `createBillableJobIfUnderBound` (its
          // `Array.from` mapper runs synchronously too — see that test's own
          // corrected comment). Both tests are real and worth keeping (they
          // catch the bound being bypassed or reimplemented), just not a
          // race-freedom proof by themselves. The one test in this codebase
          // that DOES exercise genuine interleaving for a bound built on this
          // same primitive is `POST /api/generate`'s own concurrent test,
          // because that handler has a real `await readJsonBody(req)` before
          // its own count-and-insert section.
          const created = createBillableJobIfUnderBound(db, input);
          if (created === null) {
            sendJson(res, 429, ENQUEUE_BOUND_REFUSED);
            return;
          }
          sendJson(res, 202, { jobId: created.id });
          return;
        }

        // Non-billable (export): no SPEND cap check at all — the same "never
        // refuse over the cap" rule /__export's own registry entry states,
        // for the same reason (a deterministic build spends no model money;
        // refusing it would strand already-generated work behind a bill).
        //
        // It IS subject to the concurrency bound, though (whole-branch
        // review, FINDING D): this used to be a plain, unconditional
        // `createJob`, which made resume the one door through which an
        // unbounded number of export rows could still be created after
        // `compiler-routes.ts`'s own enqueue was bounded. A bound with a
        // bypass is not a bound.
        const created = createNonBillableAsyncJobIfUnderBound(db, input);
        if (created === null) {
          sendJson(res, 429, NON_BILLABLE_ENQUEUE_BOUND_REFUSED);
          return;
        }
        sendJson(res, 202, { jobId: created.id });
      }),
    },
    {
      method: "GET",
      path: "/api/jobs",
      handler: requireProject(db, BY_QUERY, (_req, res, ctx) => {
        const jobs = listJobsByProject(db, ctx.project.id, PROJECT_JOB_LIST_LIMIT);
        sendJson(res, 200, { jobs: jobs.map(publicJobView) });
      }),
    },
  ];
}
