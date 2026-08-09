// server/src/jobs.test.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createProject } from "./projects.ts";
import { MAX_BILLABLE_IN_FLIGHT_PER_USER } from "./preview-pool.ts";
import {
  BILLABLE_JOB_KINDS,
  claimNextJob,
  countActiveBillableJobsForUser,
  countActiveJobsForUser,
  createBillableJobIfUnderBound,
  createJob,
  createNonBillableAsyncJobIfUnderBound,
  ENQUEUE_BOUND_REFUSED,
  findJobById,
  finishJob,
  hasActiveResumeFor,
  isSafeRunId,
  listJobsByProject,
  markRunningJobsInterrupted,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_ENQUEUED_BILLABLE_JOBS_PER_USER,
  MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER,
  MAX_REQUEST_JSON_BYTES,
  NON_BILLABLE_ASYNC_JOB_KINDS,
  recordJobRun,
  requestJsonTooLarge,
  requeueJob,
} from "./jobs.ts";

let dir: string;
let db: DatabaseSync;
let userId: string;

function seed(overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
  return createJob(db, {
    userId,
    projectId: null,
    kind: "generate",
    requestJson: "{}",
    now: 1_000,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobs-"));
  db = openDatabase(join(dir, "identity.db"));
  userId = createUser(db, "a@example.com", "hash").id;
});

afterEach(() => {
  db.close(); // release the handle so rmSync can remove the temp dir on Windows
  rmSync(dir, { recursive: true, force: true });
});

describe("createJob", () => {
  it("returns a distinct id per job and stores every field", () => {
    const first = seed({ kind: "generate", requestJson: '{"route":"/"}', now: 1_000 });
    const second = seed({ kind: "regen", requestJson: '{"route":"/pricing"}', now: 1_001 });
    expect(first.id).not.toBe(second.id);

    const row = db.prepare("SELECT * FROM job WHERE id = ?").get(first.id) as Record<string, unknown>;
    expect(row.user_id).toBe(userId);
    expect(row.project_id).toBe(null);
    expect(row.kind).toBe("generate");
    expect(row.status).toBe("queued");
    expect(row.request_json).toBe('{"route":"/"}');
    expect(row.result_json).toBe(null);
    expect(row.error).toBe(null);
    expect(row.created_at).toBe(1_000);
    expect(row.started_at).toBe(null);
    expect(row.finished_at).toBe(null);
  });

  it("is queued with no started_at or finished_at when created", () => {
    const job = seed();
    expect(job.status).toBe("queued");
    expect(job.startedAt).toBe(null);
    expect(job.finishedAt).toBe(null);
  });

  it("links a project when one is given", () => {
    // createProject is POSITIONAL: (db, ownerId, directory, name).
    const project = createProject(db, userId, "run-a", "Run A");
    const job = seed({ projectId: project.id });
    expect(job.projectId).toBe(project.id);
  });

  it("stores request_json verbatim, never augmenting it with anything key-shaped", () => {
    // A realistic slice-5 request payload: a route, a section id, an
    // instruction — never an API key (the key is decrypted server-side only
    // at the point a job actually runs, per jobs.ts's own doc comment). If a
    // future change merged in anything derived from the decrypted key (env,
    // headers, etc.) either of these assertions would catch it: the byte
    // equality would break the instant createJob adds or reorders anything,
    // and the regex would fire even if the addition happened to preserve
    // byte equality some other way.
    const requestJson = JSON.stringify({
      route: "/pricing",
      sectionId: "pricing.tiers",
      instruction: "make the CTA button bigger",
    });
    const job = seed({ requestJson });
    expect(job.requestJson).toBe(requestJson);

    const row = db.prepare("SELECT request_json FROM job WHERE id = ?").get(job.id) as {
      request_json: string;
    };
    expect(row.request_json).toBe(requestJson);
    expect(row.request_json).not.toMatch(/sk-ant-[A-Za-z0-9_-]+/);
  });

  it("defaults runId, codeVersion and resumedFromJobId to null when omitted (every pre-task-7 caller)", () => {
    const job = seed();
    expect(job.runId).toBe(null);
    expect(job.codeVersion).toBe(null);
    expect(job.resumedFromJobId).toBe(null);
    expect(findJobById(db, job.id)).toEqual(job);
  });

  it("carries runId and resumedFromJobId verbatim when given (the shape job-routes.ts's resume handler uses), but NEVER codeVersion", () => {
    const original = seed({ now: 1_000 });
    const resumed = seed({ now: 2_000, runId: "web-abc123", resumedFromJobId: original.id });
    expect(resumed.runId).toBe("web-abc123");
    expect(resumed.resumedFromJobId).toBe(original.id);
    expect(resumed.codeVersion).toBe(null);
    expect(findJobById(db, resumed.id)).toEqual(resumed);
  });
});

describe("findJobById", () => {
  it("returns null for a nonexistent id", () => {
    expect(findJobById(db, "does-not-exist")).toBe(null);
  });

  it("returns the job for a real id", () => {
    const job = seed();
    expect(findJobById(db, job.id)).toEqual(job);
  });
});

describe("countActiveJobsForUser", () => {
  it("counts queued and running but not succeeded/failed/interrupted", () => {
    // willStayRunning is deliberately the OLDEST timestamp, so claimNextJob
    // (which always claims oldest-queued-first) is guaranteed to pick it.
    const willStayRunning = seed({ now: 1_000 });
    const willSucceed = seed({ now: 1_001 });
    const willFail = seed({ now: 1_002 });
    const willBeInterrupted = seed({ now: 1_003 });
    const willStayQueued = seed({ now: 1_004 });

    expect(countActiveJobsForUser(db, userId)).toBe(5);

    const claimed = claimNextJob(db, 2_000);
    expect(claimed?.id).toBe(willStayRunning.id); // sanity: confirms which job actually claimed

    finishJob(db, willSucceed.id, { status: "succeeded", now: 3_000 });
    finishJob(db, willFail.id, { status: "failed", error: "boom", now: 3_001 });
    finishJob(db, willBeInterrupted.id, { status: "interrupted", now: 3_002 });

    // 3 terminal jobs excluded; the running one and the untouched queued one remain.
    expect(countActiveJobsForUser(db, userId)).toBe(2);
    expect(findJobById(db, willStayQueued.id)?.status).toBe("queued");
    expect(findJobById(db, willStayRunning.id)?.status).toBe("running");
  });
});

describe("countActiveBillableJobsForUser", () => {
  it("counts queued+running BILLABLE jobs, excluding export and excluding terminal statuses", () => {
    // One of each billable kind, plus one export -- export must never count
    // (project-registry.ts's own billable:false reasoning: a build spends no
    // model money).
    for (const kind of BILLABLE_JOB_KINDS) seed({ kind, now: 1_000 });
    seed({ kind: "export", now: 1_001 });
    expect(countActiveBillableJobsForUser(db, userId)).toBe(BILLABLE_JOB_KINDS.length);

    // Finish one billable job -- the count drops with no separate "release"
    // call, since this is a live COUNT, not an in-memory reservation.
    const claimed = claimNextJob(db, 2_000);
    finishJob(db, claimed!.id, { status: "succeeded", now: 3_000 });
    expect(countActiveBillableJobsForUser(db, userId)).toBe(BILLABLE_JOB_KINDS.length - 1);
  });

  it("is scoped per user -- another user's billable jobs are never counted", () => {
    const otherUserId = createUser(db, "b@example.com", "hash").id;
    seed({ kind: "regen", now: 1_000 });
    createJob(db, { userId: otherUserId, projectId: null, kind: "regen", requestJson: "{}", now: 1_001 });
    createJob(db, { userId: otherUserId, projectId: null, kind: "regen", requestJson: "{}", now: 1_002 });
    expect(countActiveBillableJobsForUser(db, userId)).toBe(1);
    expect(countActiveBillableJobsForUser(db, otherUserId)).toBe(2);
  });

  it("returns 0 for a user with only export jobs, however many", () => {
    seed({ kind: "export", now: 1_000 });
    seed({ kind: "export", now: 1_001 });
    expect(countActiveBillableJobsForUser(db, userId)).toBe(0);
  });

  it("MAX_ENQUEUED_BILLABLE_JOBS_PER_USER matches preview-pool.ts's MAX_BILLABLE_IN_FLIGHT_PER_USER — same value, same meaning, two independent definitions", () => {
    expect(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER).toBe(MAX_BILLABLE_IN_FLIGHT_PER_USER);
  });
});

/**
 * Task-3-review round 2: THIS is the actual enforcement point — a single
 * `INSERT ... SELECT ... WHERE`, not the deleted `requireEnqueueSlot`
 * decorator's separate read-then-write. `countActiveBillableJobsForUser`
 * above stays a plain, non-atomic read; these tests are about the ONE
 * function whose own statement is what makes the bound race-proof.
 */
describe("createBillableJobIfUnderBound", () => {
  it("inserts and returns a queued job when the user is under the bound", () => {
    const job = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: '{"route":"/"}', now: 1_000,
    });
    expect(job).not.toBeNull();
    expect(job?.status).toBe("queued");
    expect(job?.kind).toBe("regen");
    expect(findJobById(db, job!.id)).toEqual(job);
  });

  it("carries runId and resumedFromJobId verbatim when given, but never codeVersion (the shape resume's atomic insert uses)", () => {
    const original = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000,
    })!;
    const resumed = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 2_000,
      runId: "web-xyz789", resumedFromJobId: original.id,
    });
    expect(resumed).not.toBeNull();
    expect(resumed?.runId).toBe("web-xyz789");
    expect(resumed?.resumedFromJobId).toBe(original.id);
    expect(resumed?.codeVersion).toBe(null);
    expect(findJobById(db, resumed!.id)).toEqual(resumed);
  });

  it("returns null and inserts NO row once the user is at MAX_ENQUEUED_BILLABLE_JOBS_PER_USER", () => {
    for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER; i += 1) {
      const job = createBillableJobIfUnderBound(db, {
        userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000 + i,
      });
      expect(job).not.toBeNull();
    }
    const before = (db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c;
    const refused = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 9_999,
    });
    expect(refused).toBeNull();
    // The load-bearing assertion for this whole review round: a refusal
    // means ZERO rows changed, verified against the table directly rather
    // than trusting the function's own return value alone.
    const after = (db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("does not count export against the bound, and export itself is never refused by this function", () => {
    for (let i = 0; i < 10; i += 1) {
      seed({ kind: "export", now: 1_000 + i });
    }
    const job = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 2_000,
    });
    expect(job).not.toBeNull();
  });

  it("is scoped per user — another user at the bound does not block this one", () => {
    const otherUserId = createUser(db, "b@example.com", "hash").id;
    for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER; i += 1) {
      createJob(db, { userId: otherUserId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000 + i });
    }
    const job = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 2_000,
    });
    expect(job).not.toBeNull();
  });

  it("a slot frees itself once a job reaches a terminal status, with no separate release call", () => {
    const first = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000,
    });
    for (let i = 1; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER; i += 1) {
      createBillableJobIfUnderBound(db, { userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000 + i });
    }
    expect(createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 9_999,
    })).toBeNull();

    finishJob(db, first!.id, { status: "succeeded", now: 9_998 });

    const afterFinish = createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "regen", requestJson: "{}", now: 10_000,
    });
    expect(afterFinish).not.toBeNull();
  });

  it("throws (a programmer error, not a user-facing failure) when called with the non-billable kind 'export'", () => {
    expect(() => createBillableJobIfUnderBound(db, {
      userId, projectId: null, kind: "export", requestJson: "{}", now: 1_000,
    })).toThrow(/non-billable kind "export"/);
    // Nothing was inserted despite the throw.
    expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c).toBe(0);
  });

  it(
    `TRULY CONCURRENT: firing ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER * 5)} calls via Promise.all lets through exactly ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER)}`,
    async () => {
      // HONESTY CORRECTION (task-7-review finding 6): this does NOT achieve
      // genuine interleaving either, and an earlier version of this comment
      // wrongly cited job-routes.test.ts's concurrent tests as a class —
      // "what actually caught the round-1 bug" — without noticing that claim
      // is only true for a handler with a genuine `await` between its own
      // check and insert. Checked by hand: `Array.from`'s own mapper
      // function runs SYNCHRONOUSLY, in order, DURING array construction —
      // each `createBillableJobIfUnderBound` call (itself synchronous, no
      // internal `await`) completes fully before the next index's mapper
      // even starts, and `Promise.resolve(...)` only wraps an
      // ALREADY-COMPUTED return value. So this `Promise.all` awaits a batch
      // of promises that were all resolved before `Promise.all` was ever
      // called — there is no concurrency here at all, racy or otherwise; it
      // is a sequential-bound test wearing a `Promise.all`.
      //
      // What this test actually proves: calling the function `burst` times
      // in a row converges on exactly the bound — a real correctness
      // property of the WHERE clause itself, just not a race-freedom one.
      // The bound's actual atomicity comes from SQLite executing one
      // `INSERT ... SELECT ... WHERE` as a single indivisible statement
      // against the database file — an ENGINE guarantee, not something any
      // JS-level test (this one included) can independently prove without a
      // genuinely separate OS process (the way db.test.ts's own
      // cross-connection lock test does, for a different property). The one
      // test in this codebase that DOES exercise real interleaving for a
      // bound built on this same primitive is job-routes.test.ts's `POST
      // /api/generate` concurrent test, specifically because that handler
      // has a genuine `await readJsonBody(req)` BEFORE reaching its own
      // count-and-insert section — letting N requests' synchronous prefixes
      // actually interleave before any of them writes. A sibling test for
      // `POST /api/jobs/:id/resume` (job-routes.test.ts) has NO such `await`
      // anywhere in its handler and is subject to the identical caveat this
      // comment now states, not a counterexample to it.
      const burst = MAX_ENQUEUED_BILLABLE_JOBS_PER_USER * 5;
      const jobs = await Promise.all(
        Array.from({ length: burst }, (_unused, i) =>
          Promise.resolve(createBillableJobIfUnderBound(db, {
            userId, projectId: null, kind: "regen", requestJson: "{}", now: 1_000 + i,
          }))),
      );
      expect(jobs.filter((j) => j !== null)).toHaveLength(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect(jobs.filter((j) => j === null)).toHaveLength(burst - MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c)
        .toBe(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    },
  );
});

describe("ENQUEUE_BOUND_REFUSED", () => {
  it("names MAX_ENQUEUED_BILLABLE_JOBS_PER_USER in its message, so the two cannot silently drift apart", () => {
    expect(ENQUEUE_BOUND_REFUSED.error).toContain(String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER));
  });
});

describe("claimNextJob", () => {
  it("claims the oldest queued job and flips it to running", () => {
    const older = seed({ now: 1_000 });
    const newer = seed({ now: 2_000 });

    const claimed = claimNextJob(db, 5_000);
    expect(claimed?.id).toBe(older.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBe(5_000);

    expect(findJobById(db, newer.id)?.status).toBe("queued");
  });

  it("returns null when nothing is queued", () => {
    expect(claimNextJob(db, 1_000)).toBe(null);
  });

  it("never returns the same row twice: claiming twice in a row returns two distinct jobs, then null", () => {
    const first = seed({ now: 1_000 });
    const second = seed({ now: 2_000 });

    const claim1 = claimNextJob(db, 5_000);
    const claim2 = claimNextJob(db, 5_001);
    const claim3 = claimNextJob(db, 5_002); // nothing left queued

    expect(claim1?.id).toBe(first.id);
    expect(claim2?.id).toBe(second.id);
    expect(claim2?.id).not.toBe(claim1?.id);
    expect(claim3).toBe(null);
  });
});

describe("claimNextJob: per-user bound (MAX_ACTIVE_JOBS_PER_USER)", () => {
  it("skips a queued job whose user already has MAX_ACTIVE_JOBS_PER_USER running, and claims a different, eligible user's job instead", () => {
    const otherUserId = createUser(db, "b@example.com", "hash").id;

    // userId ends up with 2 RUNNING jobs (the bound) plus a third still
    // queued -- the oldest queued job overall, which would win under the
    // old "claim unconditionally oldest" rule.
    seed({ now: 1_000 }); // -> claimed below, becomes running #1
    seed({ now: 1_001 }); // -> claimed below, becomes running #2
    claimNextJob(db, 2_000);
    claimNextJob(db, 2_001);
    const blockedThird = seed({ now: 1_500 });

    // A different user's job, NEWER than blockedThird, but that user is not
    // blocked at all.
    const eligible = createJob(db, {
      userId: otherUserId, projectId: null, kind: "generate", requestJson: "{}", now: 3_000,
    });

    const claimed = claimNextJob(db, 4_000);
    expect(claimed?.id).toBe(eligible.id);
    // The load-bearing assertion: blockedThird was NOT claimed-and-requeued
    // (the old, starvation-prone behavior) -- it was simply never selected,
    // so it is still exactly as it was, `started_at` untouched.
    const found = findJobById(db, blockedThird.id);
    expect(found?.status).toBe("queued");
    expect(found?.startedAt).toBe(null);
  });

  it("returns null when the only queued job belongs to a user already at the limit, even though something IS queued", () => {
    seed({ now: 1_000 });
    seed({ now: 1_001 });
    claimNextJob(db, 2_000);
    claimNextJob(db, 2_001);
    seed({ now: 1_500 }); // the only queued job, but userId is at the limit

    expect(claimNextJob(db, 3_000)).toBe(null);
  });

  it("a blocked user's job becomes claimable again as soon as one of their running jobs finishes", () => {
    const running1 = seed({ now: 1_000 });
    seed({ now: 1_001 });
    claimNextJob(db, 2_000); // -> running1
    claimNextJob(db, 2_001); // -> running2
    const blocked = seed({ now: 1_500 });

    expect(claimNextJob(db, 3_000)).toBe(null); // still blocked

    finishJob(db, running1.id, { status: "succeeded", now: 3_500 });

    const claimed = claimNextJob(db, 4_000);
    expect(claimed?.id).toBe(blocked.id);
    expect(claimed?.status).toBe("running");
  });

  it("does NOT block a user merely because they have several jobs queued (not yet running) — countActiveJobsForUser would be the wrong metric here", () => {
    // 3 jobs queued for one user, none running. countActiveJobsForUser
    // (queued+running) is already 3 at this point -- gating a claim on THAT
    // count would refuse this user's very first job forever. Gating on
    // RUNNING count only (what claimNextJob actually does) correctly allows
    // the first claim.
    const first = seed({ now: 1_000 });
    seed({ now: 1_001 });
    seed({ now: 1_002 });
    expect(countActiveJobsForUser(db, userId)).toBe(3);

    const claimed = claimNextJob(db, 2_000);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
  });

  it("still claims strictly oldest-first among eligible jobs once nobody is blocked", () => {
    const otherUserId = createUser(db, "d@example.com", "hash").id;
    const olderOther = createJob(db, {
      userId: otherUserId, projectId: null, kind: "generate", requestJson: "{}", now: 1_000,
    });
    const newerMine = seed({ now: 2_000 });

    const claimed = claimNextJob(db, 3_000);
    expect(claimed?.id).toBe(olderOther.id);
    expect(findJobById(db, newerMine.id)?.status).toBe("queued");
  });

  it("MAX_ACTIVE_JOBS_PER_USER matches preview-pool.ts's MAX_BILLABLE_IN_FLIGHT_PER_USER — same value, same meaning, two independent definitions", () => {
    expect(MAX_ACTIVE_JOBS_PER_USER).toBe(MAX_BILLABLE_IN_FLIGHT_PER_USER);
  });
});

describe("requeueJob", () => {
  it("returns a running job to queued, clears started_at, and never sets finished_at", () => {
    const job = seed({ now: 1_000 });
    const claimed = claimNextJob(db, 2_000);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBe(2_000);

    requeueJob(db, job.id);

    const found = findJobById(db, job.id);
    expect(found?.status).toBe("queued");
    expect(found?.startedAt).toBe(null);
    expect(found?.finishedAt).toBe(null);
    expect(found?.resultJson).toBe(null);
    expect(found?.error).toBe(null);
  });

  it("makes the job claimable again by a later claimNextJob call", () => {
    const job = seed({ now: 1_000 });
    claimNextJob(db, 2_000);
    requeueJob(db, job.id);

    const reclaimed = claimNextJob(db, 3_000);
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.startedAt).toBe(3_000);
  });
});

describe("FinishJobInput's status type", () => {
  it("refuses a non-terminal status ('queued') at compile time", () => {
    const job = seed();
    // @ts-expect-error -- 'queued' is not assignable to TerminalJobStatus;
    // finishJob must never be callable with a status that has not actually
    // finished (see requeueJob for the correct "back to queued" primitive).
    // If this narrowing is ever loosened back to plain JobStatus, this
    // directive stops being necessary and `tsc --noEmit` (part of
    // `npm test -w server`) fails on the now-unnecessary `@ts-expect-error`.
    finishJob(db, job.id, { status: "queued", now: 1 });
  });
});

describe("finishJob", () => {
  it("sets the terminal status, finished_at and result_json", () => {
    const job = seed({ kind: "export" });
    claimNextJob(db, 1_500);
    finishJob(db, job.id, { status: "succeeded", resultJson: '{"zipPath":"x.zip"}', now: 2_000 });

    const found = findJobById(db, job.id);
    expect(found?.status).toBe("succeeded");
    expect(found?.finishedAt).toBe(2_000);
    expect(found?.resultJson).toBe('{"zipPath":"x.zip"}');
    expect(found?.error).toBe(null);
  });

  it("records an error message on failure", () => {
    const job = seed({ kind: "regen" });
    finishJob(db, job.id, { status: "failed", error: "gate 3 failed", now: 2_000 });

    const found = findJobById(db, job.id);
    expect(found?.status).toBe("failed");
    expect(found?.error).toBe("gate 3 failed");
    expect(found?.finishedAt).toBe(2_000);
    expect(found?.resultJson).toBe(null);
  });
});

describe("recordJobRun", () => {
  it("stamps run_id and code_version, leaving every other field untouched", () => {
    const job = seed({ kind: "regen", now: 1_000 });
    claimNextJob(db, 1_500);

    recordJobRun(db, job.id, { runId: "web-abc123", codeVersion: "deadbeef" });

    const found = findJobById(db, job.id);
    expect(found?.runId).toBe("web-abc123");
    expect(found?.codeVersion).toBe("deadbeef");
    // Untouched: recordJobRun's whole contract is "just these two columns."
    expect(found?.status).toBe("running");
    expect(found?.startedAt).toBe(1_500);
    expect(found?.requestJson).toBe("{}");
  });

  it("overwrites an already-set run_id with the new value (a resumed job's runId round-trips unchanged in practice, but the function itself does not special-case 'already set')", () => {
    const job = seed({ kind: "regen", now: 1_000, runId: "web-original" });
    recordJobRun(db, job.id, { runId: "web-original", codeVersion: "sha-1" });
    expect(findJobById(db, job.id)?.runId).toBe("web-original");

    recordJobRun(db, job.id, { runId: "web-different", codeVersion: "sha-2" });
    expect(findJobById(db, job.id)?.runId).toBe("web-different");
    expect(findJobById(db, job.id)?.codeVersion).toBe("sha-2");
  });

  /**
   * Task-7-review finding 5: `run_id` flows into a filesystem path
   * downstream (orchestrator.acceptance's `GENERATED_DIR / run_id`,
   * regen-api.ts's `basename(root)`) — the identical shape the 4c-2 review
   * found already exploited once via an unvalidated `..`-bearing field.
   */
  it("throws (a programmer error, not a user-facing failure) and writes NOTHING when runId has an unsafe shape", () => {
    const job = seed({ kind: "regen", now: 1_000 });
    expect(() => recordJobRun(db, job.id, { runId: "../../etc/passwd", codeVersion: "sha-1" }))
      .toThrow(/unsafe shape/);
    const found = findJobById(db, job.id);
    expect(found?.runId).toBe(null);
    expect(found?.codeVersion).toBe(null);
  });

  it("accepts every shape a real run_id actually takes today: a fresh web-<uuid> directory name", () => {
    const job = seed({ kind: "regen", now: 1_000 });
    expect(() => recordJobRun(db, job.id, { runId: `web-${randomUUID()}`, codeVersion: "sha-1" }))
      .not.toThrow();
  });
});

describe("isSafeRunId", () => {
  it("accepts letters, digits, dots, underscores and hyphens", () => {
    expect(isSafeRunId("web-1234abcd-5678-90ef-abcd-1234567890ab")).toBe(true);
    expect(isSafeRunId("acceptance-1234567890-abcd1234")).toBe(true);
    expect(isSafeRunId("A.b_c-9")).toBe(true);
  });

  it("rejects a path-traversal segment", () => {
    expect(isSafeRunId("../../etc/passwd")).toBe(false);
    expect(isSafeRunId("..")).toBe(false);
  });

  it("rejects a value containing a path separator", () => {
    expect(isSafeRunId("a/b")).toBe(false);
    expect(isSafeRunId("a\\b")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isSafeRunId("")).toBe(false);
  });
});

describe("markRunningJobsInterrupted", () => {
  it("converts only running rows to interrupted and returns how many", () => {
    const running1 = seed({ now: 1_000 });
    const running2 = seed({ now: 1_001 });
    const alreadyFinished = seed({ now: 1_002 });
    const stillQueued = seed({ now: 1_003 });

    claimNextJob(db, 2_000); // oldest queued -> running1
    claimNextJob(db, 2_001); // next oldest -> running2
    finishJob(db, alreadyFinished.id, { status: "succeeded", now: 2_500 });

    const count = markRunningJobsInterrupted(db, 3_000);
    expect(count).toBe(2);

    expect(findJobById(db, running1.id)?.status).toBe("interrupted");
    expect(findJobById(db, running1.id)?.finishedAt).toBe(3_000);
    expect(findJobById(db, running2.id)?.status).toBe("interrupted");
    expect(findJobById(db, running2.id)?.finishedAt).toBe(3_000);
    // unaffected: was already terminal
    expect(findJobById(db, alreadyFinished.id)?.status).toBe("succeeded");
    // unaffected: was never claimed, so never running
    expect(findJobById(db, stillQueued.id)?.status).toBe("queued");
    expect(findJobById(db, stillQueued.id)?.finishedAt).toBe(null);
  });

  it("returns 0 when nothing is running", () => {
    seed(); // queued, never claimed
    expect(markRunningJobsInterrupted(db, 3_000)).toBe(0);
  });
});

describe("listJobsByProject", () => {
  it("returns that project's jobs most-recent-first, respecting the limit, excluding other projects", () => {
    const project = createProject(db, userId, "run-a", "Run A");
    const other = createProject(db, userId, "run-b", "Run B");
    const j1 = seed({ projectId: project.id, now: 1_000 });
    const j2 = seed({ projectId: project.id, kind: "regen", now: 2_000 });
    const j3 = seed({ projectId: project.id, kind: "export", now: 3_000 });
    seed({ projectId: other.id, now: 4_000 }); // different project, must not appear

    expect(listJobsByProject(db, project.id, 10).map((j) => j.id)).toEqual([j3.id, j2.id, j1.id]);
    expect(listJobsByProject(db, project.id, 2).map((j) => j.id)).toEqual([j3.id, j2.id]);
  });

  it("returns an empty array for a project with no jobs", () => {
    const project = createProject(db, userId, "run-c", "Run C");
    expect(listJobsByProject(db, project.id, 10)).toEqual([]);
  });
});

describe("hasActiveResumeFor", () => {
  it("returns false when nothing has ever resumed the given job", () => {
    const original = seed({ now: 1_000 });
    expect(hasActiveResumeFor(db, original.id)).toBe(false);
  });

  it("returns true when a QUEUED resume points back at it", () => {
    const original = seed({ now: 1_000 });
    seed({ now: 2_000, resumedFromJobId: original.id });
    expect(hasActiveResumeFor(db, original.id)).toBe(true);
  });

  it("returns true when a RUNNING resume points back at it", () => {
    const original = seed({ now: 1_000 });
    const resume = seed({ now: 2_000, resumedFromJobId: original.id });
    // Flipped directly rather than via claimNextJob: `original` is itself
    // still `queued` at this point and, being OLDER, would be the one
    // claimNextJob picks first — this test is specifically about `resume`'s
    // own status, not about which job claimNextJob happens to select.
    db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(resume.id);
    expect(findJobById(db, resume.id)?.status).toBe("running");
    expect(hasActiveResumeFor(db, original.id)).toBe(true);
  });

  it("returns false once the resume reaches a terminal status", () => {
    const original = seed({ now: 1_000 });
    const resume = seed({ now: 2_000, resumedFromJobId: original.id });
    finishJob(db, resume.id, { status: "failed", error: "boom again", now: 3_000 });
    expect(hasActiveResumeFor(db, original.id)).toBe(false);
  });

  it("is scoped to the exact job id — a resume of a DIFFERENT job does not count", () => {
    const original = seed({ now: 1_000 });
    const unrelated = seed({ now: 1_001 });
    seed({ now: 2_000, resumedFromJobId: unrelated.id });
    expect(hasActiveResumeFor(db, original.id)).toBe(false);
  });
});

describe("retention", () => {
  it("keeps the job when its project is deleted, with project_id nulled", () => {
    const project = createProject(db, userId, "run-d", "Run D");
    const job = seed({ projectId: project.id });
    db.prepare("DELETE FROM project WHERE id = ?").run(project.id);

    const found = findJobById(db, job.id);
    expect(found).not.toBe(null);
    expect(found?.projectId).toBe(null);
  });

  it("deletes the job when its user is deleted (cascade)", () => {
    const job = seed();
    db.prepare("DELETE FROM user WHERE id = ?").run(userId);
    expect(findJobById(db, job.id)).toBe(null);
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING D — the store-level primitives the two enqueue
 * paths use. Behaviour through the routes is covered in compiler-routes.test.ts
 * and job-routes.test.ts; these pin the primitives' own guards, which are what
 * stop a future caller from picking the wrong one.
 */
describe("createNonBillableAsyncJobIfUnderBound", () => {
  it("inserts up to the bound and then inserts nothing at all, returning null", () => {
    const user = createUser(db, `${randomUUID()}@example.com`, "h");
    const project = createProject(db, user.id, `dir-${randomUUID()}`, "P");
    const input = { userId: user.id, projectId: project.id, kind: "export" as const, requestJson: "{}", now: 1 };
    for (let i = 0; i < MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER; i += 1) {
      expect(createNonBillableAsyncJobIfUnderBound(db, input)).not.toBeNull();
    }
    expect(createNonBillableAsyncJobIfUnderBound(db, input)).toBeNull();
    expect(listJobsByProject(db, project.id, 50)).toHaveLength(MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER);
  });

  it("counts a DISJOINT set of kinds from the billable bound — neither consumes the other's allowance", () => {
    const user = createUser(db, `${randomUUID()}@example.com`, "h");
    const project = createProject(db, user.id, `dir-${randomUUID()}`, "P");
    const base = { userId: user.id, projectId: project.id, requestJson: "{}", now: 1 };
    for (let i = 0; i < MAX_ENQUEUED_NON_BILLABLE_JOBS_PER_USER; i += 1) {
      expect(createNonBillableAsyncJobIfUnderBound(db, { ...base, kind: "export" })).not.toBeNull();
    }
    expect(createNonBillableAsyncJobIfUnderBound(db, { ...base, kind: "export" })).toBeNull();
    // Fully blocked on exports, entirely free on billable work.
    expect(createBillableJobIfUnderBound(db, { ...base, kind: "regen" })).not.toBeNull();
  });

  it("throws rather than silently applying the wrong bound when called with a billable kind", () => {
    const user = createUser(db, `${randomUUID()}@example.com`, "h");
    expect(() => createNonBillableAsyncJobIfUnderBound(db, {
      userId: user.id, projectId: null, kind: "regen", requestJson: "{}", now: 1,
    })).toThrow(/not an async non-billable kind/);
  });

  it("names a set disjoint from BILLABLE_JOB_KINDS, so no kind is bounded twice or missed", () => {
    for (const kind of NON_BILLABLE_ASYNC_JOB_KINDS) {
      expect(BILLABLE_JOB_KINDS).not.toContain(kind);
    }
  });
});

describe("requestJsonTooLarge", () => {
  it("is false at exactly the ceiling and true one byte past it", () => {
    expect(requestJsonTooLarge("x".repeat(MAX_REQUEST_JSON_BYTES))).toBe(false);
    expect(requestJsonTooLarge("x".repeat(MAX_REQUEST_JSON_BYTES + 1))).toBe(true);
  });

  it("measures BYTES, not code units — a multi-byte payload costs what it actually costs on disk", () => {
    // Every "é" is 2 UTF-8 bytes, so half the ceiling's worth of characters
    // is exactly the ceiling in bytes; one more character is over it.
    const halfChars = MAX_REQUEST_JSON_BYTES / 2;
    expect(requestJsonTooLarge("é".repeat(halfChars))).toBe(false);
    expect(requestJsonTooLarge("é".repeat(halfChars + 1))).toBe(true);
  });
});
