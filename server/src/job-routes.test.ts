// server/src/job-routes.test.ts
/**
 * Drives the real, composed route table (createRequestListener(jobRoutes(...)))
 * — no fake pool needed, since none of these three endpoints ever touches
 * one (job-routes.ts's own module comment).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createJob, finishJob, findJobById } from "./jobs.ts";
import { jobRoutes } from "./job-routes.ts";
import { createProject, resolveProjectDirectory } from "./projects.ts";
import { NOT_FOUND } from "./require-project.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { recordUsageEvent } from "./usage.ts";
import { createUser } from "./users.ts";

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
