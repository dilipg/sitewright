// server/src/job-routes.test.ts
/**
 * Drives the real, composed route table (createRequestListener(jobRoutes(...)))
 * — no fake pool needed, since none of these three endpoints ever touches
 * one (job-routes.ts's own module comment).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createJob, finishJob, findJobById, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER } from "./jobs.ts";
import { jobRoutes } from "./job-routes.ts";
import { createProject, resolveProjectDirectory } from "./projects.ts";
import { NOT_FOUND } from "./require-project.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { recordUsageEvent } from "./usage.ts";
import { createUser } from "./users.ts";

/**
 * Task-3-review finding 5: `mkdirSync` toggled to throw on demand, real
 * otherwise — proves job-routes.ts creates the project's directory BEFORE
 * inserting its row, not after. `vi.mock` is per-test-file (vitest's default
 * isolation), so this affects only this file's own module graph, not any
 * other test file's real filesystem calls.
 */
const mkdirControl = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      if (mkdirControl.shouldThrow) throw new Error("ENOSPC: no space left on device (simulated)");
      return actual.mkdirSync(...args);
    },
  };
});

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "server-jobroutes-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  const projectsRoot = mkdtempSync(join(tmpdir(), "server-jobroutes-projects-"));
  dirs.push(projectsRoot);
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const listener = createRequestListener(jobRoutes({ db, projectsRoot }));

  async function call(method: string, path: string, cookie?: string, body?: unknown, raw?: Buffer) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const payload = raw !== undefined ? [raw] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(
      (async function* () { yield* payload; })(),
      { method, url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) } },
    );
    await listener(req as never, res as never);
    const text = chunks.join("");
    return { status, body: text, json: text === "" ? undefined : JSON.parse(text) };
  }

  return {
    db, projectsRoot, alice, bob, call,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
  };
}
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function overCap(db: DatabaseSync, userId: string): void {
  // Default cap is $10; one event alone puts this user over it — same idiom
  // require-budget.test.ts and project-registry.test.ts use.
  recordUsageEvent(db, {
    userId, projectId: null, role: "section", model: "claude-sonnet-5",
    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: 11, at: Date.now(),
  });
}

describe("POST /api/generate", () => {
  it("creates a project row AND its directory on disk, enqueues a generate job, and answers 202", async () => {
    const { db, projectsRoot, alice, call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, { brief: "a bakery landing page" });

    expect(result.status).toBe(202);
    const body = result.json as { jobId: string; projectId: string };
    expect(typeof body.jobId).toBe("string");
    expect(typeof body.projectId).toBe("string");

    // The project row exists and is owned by the caller.
    const projectRow = db.prepare("SELECT owner_id, directory FROM project WHERE id = ?").get(body.projectId) as
      | { owner_id: string; directory: string }
      | undefined;
    expect(projectRow).toBeDefined();
    expect(projectRow?.owner_id).toBe(alice.id);

    // The directory exists on disk, immediately — not merely a row promising
    // one, since a generate job's own worker has not run yet.
    const resolvedDir = resolveProjectDirectory(projectsRoot, projectRow!.directory);
    expect(existsSync(resolvedDir)).toBe(true);

    // The job row: queued, owned by the caller, referencing the new project,
    // carrying the brief verbatim (no API key — jobs.ts's own binding rule).
    const job = findJobById(db, body.jobId);
    expect(job).not.toBeNull();
    expect(job?.userId).toBe(alice.id);
    expect(job?.projectId).toBe(body.projectId);
    expect(job?.kind).toBe("generate");
    expect(job?.status).toBe("queued");
    expect(job?.requestJson).toBe(JSON.stringify({ brief: "a bakery landing page" }));
  });

  it("401s without a session, creating neither a project nor a job", async () => {
    const { db, call } = harness();
    const result = await call("POST", "/api/generate", undefined, { brief: "anything" });
    expect(result.status).toBe(401);
    expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c).toBe(0);
  });

  it("refuses with 402 over the spend cap, creating NEITHER a project NOR a job row", async () => {
    const { db, call, alice, aliceCookie } = harness();
    overCap(db, alice.id);
    const result = await call("POST", "/api/generate", aliceCookie, { brief: "a bakery landing page" });
    expect(result.status).toBe(402);
    const body = result.json as { capUsd: number; spentUsd: number; resetAt: number | null };
    expect(body.capUsd).toBe(10);
    expect(body.spentUsd).toBe(11);
    expect(typeof body.resetAt).toBe("number");
    // The binding constraint: the spend cap gates ENQUEUE. No side effect at
    // all — not a project, not a job.
    expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c).toBe(0);
  });

  it("refuses with 402 over the cap even when the body is malformed JSON — the cap is checked before the body is ever read", async () => {
    const { db, call, alice, aliceCookie } = harness();
    overCap(db, alice.id);
    const result = await call("POST", "/api/generate", aliceCookie, undefined, Buffer.from("not json at all"));
    expect(result.status).toBe(402);
  });

  it("rejects a missing brief with 400, creating neither a project nor a job", async () => {
    const { db, call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, {});
    expect(result.status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c).toBe(0);
  });

  it("rejects a whitespace-only brief with 400", async () => {
    const { call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, { brief: "   " });
    expect(result.status).toBe(400);
  });

  it("rejects a non-string brief with 400", async () => {
    const { call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, { brief: 12345 });
    expect(result.status).toBe(400);
  });

  it("rejects a malformed-JSON body with 400, not 500", async () => {
    const { call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, undefined, Buffer.from("{not json"));
    expect(result.status).toBe(400);
  });

  it("trims the brief before storing it as the project name and the job's request_json", async () => {
    const { db, call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, { brief: "  a bakery landing page  " });
    const body = result.json as { jobId: string; projectId: string };
    const projectRow = db.prepare("SELECT name FROM project WHERE id = ?").get(body.projectId) as { name: string };
    expect(projectRow.name).toBe("a bakery landing page");
    expect(findJobById(db, body.jobId)?.requestJson).toBe(JSON.stringify({ brief: "a bakery landing page" }));
  });

  it("gives two different generate requests two different project directories", async () => {
    const { db, call, aliceCookie } = harness();
    const first = (await call("POST", "/api/generate", aliceCookie, { brief: "site one" })).json as { projectId: string };
    const second = (await call("POST", "/api/generate", aliceCookie, { brief: "site two" })).json as { projectId: string };
    const firstDir = (db.prepare("SELECT directory FROM project WHERE id = ?").get(first.projectId) as { directory: string }).directory;
    const secondDir = (db.prepare("SELECT directory FROM project WHERE id = ?").get(second.projectId) as { directory: string }).directory;
    expect(firstDir).not.toBe(secondDir);
  });

  /**
   * Task-3-review finding 5: directory creation must happen BEFORE the
   * project row is inserted, so a failure leaves at worst a harmless orphan
   * directory and no row pointing nowhere. Perturbing the fix (swapping the
   * order back) makes this fail — see this task's own report.
   */
  it("creates NO project row when mkdirSync throws (directory-then-row ordering)", async () => {
    const { db, call, aliceCookie } = harness();
    mkdirControl.shouldThrow = true;
    try {
      const result = await call("POST", "/api/generate", aliceCookie, { brief: "a bakery landing page" });
      expect(result.status).toBe(500);
      expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c).toBe(0);
    } finally {
      mkdirControl.shouldThrow = false;
    }
  });

  it("rejects a malformed JSON body with the SAME message enqueueHandler's BAD_JSON_BODY uses, not the missing-brief message", async () => {
    const { call, aliceCookie } = harness();
    const result = await call("POST", "/api/generate", aliceCookie, undefined, Buffer.from("{not json"));
    expect(result.status).toBe(400);
    expect((result.json as { error: string }).error).toBe(
      "request body must be valid JSON within the size limit",
    );
  });

  /**
   * Task-3-review finding 1 / round 2: `POST /api/generate` starts the most
   * expensive of all six job kinds and is session-only (no project exists
   * yet), so it is the one call site that ALSO creates a project row and a
   * directory — a plain `countActiveBillableJobsForUser` read followed by
   * separate `createProject`/`createJob` writes (round 1's shape, via the
   * since-deleted `requireEnqueueSlot` decorator) is not atomic, and every
   * test in this block used to fire SEQUENTIALLY, which cannot observe that:
   * proven empirically by the re-reviewer (10 concurrent requests for one
   * user via `Promise.all` produced 10/10 202s against a bound of 2, plus 10
   * project rows and 10 directories). The fix wraps the count check and BOTH
   * inserts in one real `BEGIN IMMEDIATE` transaction — see job-routes.ts's
   * own module comment for the full account, including why the atomic
   * `INSERT ... SELECT ... WHERE` `compiler-routes.ts` uses for its five
   * proxied kinds is not sufficient here on its own (the project row and
   * directory precede the job insert, so gating only the job insert would
   * still leave both behind for a refused request).
   *
   * The sequential tests below are KEPT — a different, still-real property
   * (the bound survives across separate, COMPLETED requests) — with a
   * concurrent test ADDED first.
   */
  describe("per-user billable enqueue bound (BEGIN IMMEDIATE transaction, job-routes.ts's own)", () => {
    it(`allows exactly ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER)} of ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER * 5)} TRULY CONCURRENT generate requests for one user (Promise.all, no await between requests) — matching project-row, directory, and job-row counts, not merely matching HTTP statuses`, async () => {
      const { db, projectsRoot, call, aliceCookie } = harness();
      const burst = MAX_ENQUEUED_BILLABLE_JOBS_PER_USER * 5;
      const results = await Promise.all(
        Array.from({ length: burst }, (_unused, i) =>
          call("POST", "/api/generate", aliceCookie, { brief: `concurrent site ${String(i)}` })),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 202)).toHaveLength(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect(statuses.filter((s) => s === 429)).toHaveLength(burst - MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect(statuses.every((s) => s === 202 || s === 429)).toBe(true);

      // The load-bearing assertions: every row count matches the bound
      // exactly, independent of what the HTTP responses themselves claimed.
      // A race that let extra rows through would inflate these even if (by
      // coincidence) the status codes still looked right.
      expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c)
        .toBe(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c)
        .toBe(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);

      // Directories on disk: exactly the accepted requests' worth, not the
      // burst's worth and not the refused requests' worth — a refused
      // request's directory (created before the bound check, per
      // job-routes.ts's own ordering) must be cleaned up, not merely have no
      // row pointing at it.
      const dirs = readdirSync(projectsRoot).filter((name) => name.startsWith("web-"));
      expect(dirs).toHaveLength(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    });

    it(`refuses the ${String(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER + 1)}th SEQUENTIAL generate request with 429, creating NEITHER a project NOR a job row for it`, async () => {
      const { db, call, aliceCookie } = harness();
      const results: number[] = [];
      for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER + 1; i += 1) {
        const result = await call("POST", "/api/generate", aliceCookie, { brief: `site ${String(i)}` });
        results.push(result.status);
      }
      expect(results.slice(0, MAX_ENQUEUED_BILLABLE_JOBS_PER_USER)).toEqual(
        Array(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER).fill(202),
      );
      expect(results[MAX_ENQUEUED_BILLABLE_JOBS_PER_USER]).toBe(429);
      expect((db.prepare("SELECT COUNT(*) AS c FROM project").get() as { c: number }).c)
        .toBe(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
      expect((db.prepare("SELECT COUNT(*) AS c FROM job").get() as { c: number }).c)
        .toBe(MAX_ENQUEUED_BILLABLE_JOBS_PER_USER);
    });

    it("is scoped per user -- bob is unaffected by alice being at the bound", async () => {
      const { call, aliceCookie, bobCookie } = harness();
      for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER; i += 1) {
        await call("POST", "/api/generate", aliceCookie, { brief: `site ${String(i)}` });
      }
      const aliceBlocked = await call("POST", "/api/generate", aliceCookie, { brief: "one too many" });
      expect(aliceBlocked.status).toBe(429);
      const bobResult = await call("POST", "/api/generate", bobCookie, { brief: "bob's first" });
      expect(bobResult.status).toBe(202);
    });

    it("frees a slot as soon as a generate job reaches a terminal status", async () => {
      const { db, call, aliceCookie } = harness();
      const jobIds: string[] = [];
      for (let i = 0; i < MAX_ENQUEUED_BILLABLE_JOBS_PER_USER; i += 1) {
        const result = await call("POST", "/api/generate", aliceCookie, { brief: `site ${String(i)}` });
        jobIds.push((result.json as { jobId: string }).jobId);
      }
      const blocked = await call("POST", "/api/generate", aliceCookie, { brief: "one too many" });
      expect(blocked.status).toBe(429);

      finishJob(db, jobIds[0]!, { status: "failed", error: "boom", now: Date.now() });

      const afterFinish = await call("POST", "/api/generate", aliceCookie, { brief: "now it fits" });
      expect(afterFinish.status).toBe(202);
    });
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns a queued job's status", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-a", "Run A");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });

    const result = await call("GET", `/api/jobs/${job.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(expect.objectContaining({
      id: job.id, projectId: project.id, kind: "regen", status: "queued", createdAt: 1_000,
    }));
    // Not present at all while nothing has finished — an absent field, not
    // `null`, matches the design doc's own `result?`/`error?` shape.
    expect(result.json).not.toHaveProperty("result");
    expect(result.json).not.toHaveProperty("error");
  });

  it("returns a succeeded job's parsed result", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-b", "Run B");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "export", requestJson: "{}", now: 1_000 });
    finishJob(db, job.id, { status: "succeeded", resultJson: JSON.stringify({ zipPath: "x.zip" }), now: 2_000 });

    const result = await call("GET", `/api/jobs/${job.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(expect.objectContaining({
      status: "succeeded", finishedAt: 2_000, result: { zipPath: "x.zip" },
    }));
    expect(result.json).not.toHaveProperty("error");
  });

  it("returns a failed job's error message, with no result field", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-c", "Run C");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });
    finishJob(db, job.id, { status: "failed", error: "gate 3 failed", now: 2_000 });

    const result = await call("GET", `/api/jobs/${job.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(expect.objectContaining({ status: "failed", error: "gate 3 failed" }));
    expect(result.json).not.toHaveProperty("result");
  });

  it("returns interrupted verbatim — not remapped to failed", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-d", "Run D");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });
    finishJob(db, job.id, { status: "interrupted", now: 2_000 });

    const result = await call("GET", `/api/jobs/${job.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect((result.json as { status: string }).status).toBe("interrupted");
  });

  it("401s without a session", async () => {
    const { db, alice, call } = harness();
    const project = createProject(db, alice.id, "run-e", "Run E");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });
    expect((await call("GET", `/api/jobs/${job.id}`)).status).toBe(401);
  });

  it("404s another user's job, byte-identically to a nonexistent one — a job id must not be an enumeration oracle", async () => {
    const { db, alice, call, bobCookie } = harness();
    const project = createProject(db, alice.id, "run-f", "Run F");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });

    const foreign = await call("GET", `/api/jobs/${job.id}`, bobCookie);
    const absent = await call("GET", "/api/jobs/does-not-exist", bobCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toBe(absent.body);
    // Not merely internally consistent with itself — the exact same shared
    // constant requireProject.ts's own 404 uses, per the binding constraint
    // ("job ids must not be an enumeration oracle, using the same shared
    // constant requireProject uses").
    expect(foreign.json).toEqual(NOT_FOUND);
  });

  it("still answers 200 for the owner's job after its project has been deleted — ownership is on the job, not the project", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-g", "Run G");
    const job = createJob(db, { userId: alice.id, projectId: project.id, kind: "generate", requestJson: "{}", now: 1_000 });
    db.prepare("DELETE FROM project WHERE id = ?").run(project.id);

    const result = await call("GET", `/api/jobs/${job.id}`, aliceCookie);
    expect(result.status).toBe(200);
    // project_id is ON DELETE SET NULL (jobs.ts's own schema comment) — the
    // job survives, just with no project to point at any more.
    expect((result.json as { projectId: string | null }).projectId).toBe(null);
  });
});

describe("GET /api/jobs?project=<id>", () => {
  it("returns the project's jobs, most recent first", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-h", "Run H");
    const j1 = createJob(db, { userId: alice.id, projectId: project.id, kind: "regen", requestJson: "{}", now: 1_000 });
    const j2 = createJob(db, { userId: alice.id, projectId: project.id, kind: "export", requestJson: "{}", now: 2_000 });

    const result = await call("GET", `/api/jobs?project=${project.id}`, aliceCookie);
    expect(result.status).toBe(200);
    const body = result.json as { jobs: Array<{ id: string }> };
    expect(body.jobs.map((j) => j.id)).toEqual([j2.id, j1.id]);
  });

  it("returns an empty list, not a 404, for a project with no jobs", async () => {
    const { db, alice, call, aliceCookie } = harness();
    const project = createProject(db, alice.id, "run-i", "Run I");
    const result = await call("GET", `/api/jobs?project=${project.id}`, aliceCookie);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ jobs: [] });
  });

  it("401s without a session", async () => {
    const { db, alice, call } = harness();
    const project = createProject(db, alice.id, "run-j", "Run J");
    expect((await call("GET", `/api/jobs?project=${project.id}`)).status).toBe(401);
  });

  it("404s another user's project, identically to a nonexistent one", async () => {
    const { db, alice, call, bobCookie } = harness();
    const project = createProject(db, alice.id, "run-k", "Run K");
    const foreign = await call("GET", `/api/jobs?project=${project.id}`, bobCookie);
    const absent = await call("GET", "/api/jobs?project=nope", bobCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toBe(absent.body);
  });
});
