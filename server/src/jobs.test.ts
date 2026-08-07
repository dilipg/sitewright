// server/src/jobs.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createUser } from "./users.ts";
import { createProject } from "./projects.ts";
import {
  claimNextJob,
  countActiveJobsForUser,
  createJob,
  findJobById,
  finishJob,
  listJobsByProject,
  markRunningJobsInterrupted,
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
