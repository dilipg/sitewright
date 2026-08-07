// server/src/jobs.test.ts
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
  ENQUEUE_BOUND_REFUSED,
  findJobById,
  finishJob,
  listJobsByProject,
  markRunningJobsInterrupted,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_ENQUEUED_BILLABLE_JOBS_PER_USER,
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
      // node:sqlite's DatabaseSync is fully synchronous, so this doesn't
      // reproduce the HTTP-layer race by itself (there is no `await` inside
      // this function for another call to interleave with) — it instead
      // pins the property the atomic statement is SUPPOSED to guarantee
      // regardless of caller shape, as a second, lower-level layer of
      // coverage alongside compiler-routes.test.ts's and job-routes.test.ts's
      // own real concurrent HTTP tests (which DO have `await` boundaries
      // between a request's session/ownership/key checks and this call, and
      // are what actually caught the round-1 bug).
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
