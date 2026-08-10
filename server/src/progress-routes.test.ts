// server/src/progress-routes.test.ts
/**
 * Drives the real, composed route table (createRequestListener(progressRoutes(...)))
 * for the HTTP-shaped properties, and `summarizeRunLog` directly for the
 * counting rules — the same split job-routes.test.ts uses, and the reason
 * `summarizeRunLog` is a pure function of the log's text.
 *
 * Every test here is written so that removing the behaviour it names fails IT
 * specifically. The three perturbations the task brief requires are noted by
 * name on the tests that catch them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { createJob, recordJobRun } from "./jobs.ts";
import {
  defaultRunlogDir, MAX_PROGRESS_EVENTS, ORCHESTRATOR_RUNLOG_DIR_ENV_VAR, PRELUDE_STAGES,
  PROGRESS_STAGES, progressRoutes, summarizeRunLog,
} from "./progress-routes.ts";
import { createProject } from "./projects.ts";
import { NOT_FOUND } from "./require-project.ts";
import { createRequestListener } from "./router.ts";
import { createSession, SESSION_COOKIE } from "./sessions.ts";
import { recordUsageEvent } from "./usage.ts";
import { createUser } from "./users.ts";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "server-progress-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "identity.db"));
  dbs.push(db);
  // A run-log directory nested one level down inside the temp dir, so a
  // `..`-bearing run id has somewhere real to escape TO — see the traversal
  // test below.
  const runlogDir = join(dir, "runlog");
  mkdirSync(runlogDir, { recursive: true });
  const alice = createUser(db, "a@example.com", "h");
  const bob = createUser(db, "b@example.com", "h");
  const listener = createRequestListener(progressRoutes({ db, runlogDir }));

  async function call(method: string, path: string, cookie?: string) {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; res.headersSent = true; return res; },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const req = Object.assign((async function* () {})(), {
      method, url: path, headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
    });
    await listener(req as never, res as never);
    const text = chunks.join("");
    return { status, body: text, json: text === "" ? undefined : JSON.parse(text) };
  }

  /**
   * A job in the state the browser polls: owned by `alice`, `run_id` stamped
   * the way job-worker.ts stamps it (from the project's directory), so the
   * endpoint has a log file name to look for.
   */
  function jobWithRunId(runId: string): string {
    const project = createProject(db, alice.id, runId, "Progress");
    const job = createJob(db, {
      userId: alice.id, projectId: project.id, kind: "generate",
      requestJson: JSON.stringify({ brief: "a bakery" }), now: Date.now(),
    });
    recordJobRun(db, job.id, { runId, codeVersion: "test-code-version" });
    return job.id;
  }

  return {
    db, runlogDir, alice, bob, call, jobWithRunId,
    aliceCookie: `${SESSION_COOKIE}=${createSession(db, alice.id).id}`,
    bobCookie: `${SESSION_COOKIE}=${createSession(db, bob.id).id}`,
  };
}

/** mkdir -p + write: the decoy file below lives one directory ABOVE the run-log directory. */
function writeLog(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** One JSONL line, in the orchestrator's own field shape. */
function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), run_id: "r", ...fields });
}

describe("GET /api/jobs/:id/progress", () => {
  it("reports the stage and section counts for a running generate job", async () => {
    // The task brief's own named test: the prelude partly done and 2 of an
    // as-yet-unknown number of sections generated.
    const h = harness();
    const jobId = h.jobWithRunId("web-running");
    writeLog(join(h.runlogDir, "web-running.jsonl"), [
      line({ event_type: "intake.complete" }),
      line({ event_type: "plan.complete" }),
      line({ event_type: "section.generated" }),
      line({ event_type: "section.generated" }),
    ].join("\n"));

    const res = await h.call("GET", `/api/jobs/${jobId}/progress`, h.aliceCookie);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      sectionsGenerated: 2,
      stage: "generating sections",
      stagesDone: 2,
    });
  });

  it("401s without a session", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-unauthed");
    const res = await h.call("GET", `/api/jobs/${jobId}/progress`);
    expect(res.status).toBe(401);
  });

  /**
   * PERTURBATION 2 (task brief): delete the `job.userId !== ctx.user.id`
   * comparison and this test fails — bob receives alice's real progress.
   */
  it("404s another user's job, byte-identically to a job id that does not exist", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-alices");
    writeLog(join(h.runlogDir, "web-alices.jsonl"), line({ event_type: "shell.complete" }));

    const foreign = await h.call("GET", `/api/jobs/${jobId}/progress`, h.bobCookie);
    const absent = await h.call("GET", "/api/jobs/00000000-0000-4000-8000-000000000000/progress", h.bobCookie);

    expect(foreign.status).toBe(404);
    // Byte-identical, not merely both-404: two distinguishable answers make a
    // job id an enumeration oracle, and the shared constant is what keeps them
    // the same without two authors having to remember to agree.
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toBe(absent.body);
    expect(foreign.json).toEqual(NOT_FOUND);
  });

  /**
   * PERTURBATION 3 (task brief): make a missing log answer 404 and BOTH of
   * these fail. A tester polls the instant they press the button, and the
   * honest answer is "nothing has happened yet," not an error.
   */
  it("200s with zero counts for a job that has not started (no run id stamped yet)", async () => {
    const h = harness();
    const project = createProject(h.db, h.alice.id, "web-queued", "Queued");
    const job = createJob(h.db, {
      userId: h.alice.id, projectId: project.id, kind: "generate",
      requestJson: JSON.stringify({ brief: "a bakery" }), now: Date.now(),
    });

    const res = await h.call("GET", `/api/jobs/${job.id}/progress`, h.aliceCookie);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      stage: PROGRESS_STAGES.starting,
      stagesDone: 0,
      stagesTotal: PRELUDE_STAGES.length,
      sectionsGenerated: 0,
      sectionsTotal: null,
      events: [],
    });
  });

  it("200s with zero counts when the run id is stamped but the log file does not exist yet", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-no-log-yet");

    const res = await h.call("GET", `/api/jobs/${jobId}/progress`, h.aliceCookie);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ stage: PROGRESS_STAGES.starting, stagesDone: 0, sectionsGenerated: 0 });
  });

  /**
   * PERTURBATION 1 (task brief): delete the `isSafeRunId` call and this test
   * fails — the endpoint reads the decoy OUTSIDE the run-log directory and
   * reports its counts.
   *
   * The decoy matters. Without a real file to reach, a traversal test passes
   * either way (the read just ENOENTs and answers zeros), which is exactly the
   * inert-test shape this branch has already caught twice.
   */
  it("refuses a run id of unsafe shape instead of reading a log outside the run-log directory", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-traversal");
    // `<runlogDir>/../outside.jsonl` — a real, readable file with unmistakable
    // counts, one directory up from where run logs live.
    writeLog(join(h.runlogDir, "..", "outside.jsonl"), [
      line({ event_type: "intake.complete" }),
      line({ event_type: "plan.complete" }),
      line({ event_type: "tokens.complete" }),
      line({ event_type: "primitives.complete" }),
      line({ event_type: "shell.complete" }),
      line({ event_type: "section.generated", section: "home.hero" }),
      line({ event_type: "section.generated", section: "home.cta" }),
    ].join("\n"));
    // Written past the rail on purpose: `recordJobRun` would throw on this
    // shape, which is the point — the only way such a row exists is something
    // that skipped the rail, and this endpoint must not trust the column.
    h.db.prepare("UPDATE job SET run_id = ? WHERE id = ?").run("../outside", jobId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await h.call("GET", `/api/jobs/${jobId}/progress`, h.aliceCookie);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ stage: PROGRESS_STAGES.starting, stagesDone: 0, sectionsGenerated: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * The constraint that this endpoint is NOT billable, made executable: a user
   * whose own generation put them over the cap is exactly the user who most
   * needs to see how far it got. Wrapping this handler in `requireBudget` (or
   * marking it `billable` in the registry, which is what mounts that wrapper)
   * fails this test with a 402.
   */
  it("still answers over the spend cap — reading progress is never refused for money", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-over-cap");
    writeLog(join(h.runlogDir, "web-over-cap.jsonl"), line({ event_type: "shell.complete" }));
    recordUsageEvent(h.db, {
      userId: h.alice.id, projectId: null, role: "section", model: "claude-sonnet-5",
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 11, at: Date.now(),
    });

    const res = await h.call("GET", `/api/jobs/${jobId}/progress`, h.aliceCookie);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ stage: PROGRESS_STAGES.sections, stagesDone: 1 });
  });

  it("never echoes the run id, matching publicJobView's own omission", async () => {
    const h = harness();
    const jobId = h.jobWithRunId("web-secretish-run-id");
    writeLog(join(h.runlogDir, "web-secretish-run-id.jsonl"), line({ event_type: "intake.complete" }));

    const res = await h.call("GET", `/api/jobs/${jobId}/progress`, h.aliceCookie);

    expect(res.body).not.toContain("web-secretish-run-id");
  });
});

describe("summarizeRunLog — the counting rules", () => {
  it("counts a retried stage once, so stagesDone can never exceed stagesTotal", () => {
    // `primitives.complete` appears TWICE in a real generation (the design
    // step retries, and a retried checkpoint is logged as if it were a new
    // stage). Counting events rather than distinct stages reports 6 of 5.
    const report = summarizeRunLog([
      line({ event_type: "intake.complete" }),
      line({ event_type: "plan.complete" }),
      line({ event_type: "tokens.complete" }),
      line({ event_type: "primitives.complete" }),
      line({ event_type: "primitives.complete" }),
      line({ event_type: "shell.complete" }),
    ].join("\n"));

    expect(report.stagesDone).toBe(5);
    expect(report.stagesDone).toBeLessThanOrEqual(report.stagesTotal);
    expect(report.stage).toBe(PROGRESS_STAGES.sections);
  });

  it("counts distinct sections, not generation attempts", () => {
    // The real shape a gate retry produces: one section generated three times,
    // another twice. 6 events, 3 sections.
    const report = summarizeRunLog([
      line({ event_type: "section.generated", section: "home.hero", attempt: 1, checkpoint_ref: "exec-1/generate_section#a1" }),
      line({ event_type: "section.generated", section: "home.hero", attempt: 2, checkpoint_ref: "exec-1/generate_section#a2" }),
      // Measured on a live log: a retry can re-execute the flow, so the SAME
      // section reappears under a DIFFERENT checkpoint_ref prefix with the
      // attempt counter reset. Keying on the prefix over-counts here; keying
      // on `section` does not.
      line({ event_type: "section.generated", section: "home.hero", attempt: 1, checkpoint_ref: "exec-9/generate_section#a1" }),
      line({ event_type: "section.generated", section: "home.cta", attempt: 1, checkpoint_ref: "exec-2/generate_section#a1" }),
      line({ event_type: "section.generated", section: "home.cta", attempt: 2, checkpoint_ref: "exec-2/generate_section#a2" }),
      line({ event_type: "section.generated", section: "about.team", attempt: 1, checkpoint_ref: "exec-3/generate_section#a1" }),
    ].join("\n"));

    expect(report.sectionsGenerated).toBe(3);
  });

  it("falls back to the checkpoint_ref prefix when an event carries no section field", () => {
    const report = summarizeRunLog([
      line({ event_type: "section.generated", checkpoint_ref: "exec-1/generate_section#a1" }),
      line({ event_type: "section.generated", checkpoint_ref: "exec-1/generate_section#a2" }),
      line({ event_type: "section.generated", checkpoint_ref: "exec-2/generate_section#a1" }),
    ].join("\n"));

    expect(report.sectionsGenerated).toBe(2);
  });

  it("derives sectionsTotal from the plan, and reports null before the plan exists", () => {
    const plan = JSON.stringify({
      routes: [
        { slug: "home", sections: [{ slug: "hero" }, { slug: "cta" }] },
        { slug: "about", sections: [{ slug: "team" }] },
      ],
    });

    expect(summarizeRunLog(line({ event_type: "intake.complete" })).sectionsTotal).toBe(null);
    expect(summarizeRunLog([
      line({ event_type: "intake.complete" }),
      line({ event_type: "plan.complete", raw_output: plan }),
    ].join("\n")).sectionsTotal).toBe(3);
  });

  it("reports sectionsTotal as null rather than throwing when the plan payload is not the expected shape", () => {
    // `raw_output` is model-generated content reached through two layers of
    // parsing. A 500 on a status poll would be a far worse answer than "total
    // unknown".
    for (const raw of ["not json at all", "[]", JSON.stringify({ routes: "nope" }), JSON.stringify({})]) {
      const report = summarizeRunLog(line({ event_type: "plan.complete", raw_output: raw }));
      expect(report.sectionsTotal).toBe(null);
      expect(report.stagesDone).toBe(1);
    }
  });

  it("keeps a sectionsTotal an earlier readable plan established when a retried plan event is unreadable", () => {
    const plan = JSON.stringify({ routes: [{ sections: [{ slug: "hero" }, { slug: "cta" }] }] });
    const report = summarizeRunLog([
      line({ event_type: "plan.complete", raw_output: plan }),
      line({ event_type: "plan.complete", raw_output: "truncated{" }),
    ].join("\n"));
    expect(report.sectionsTotal).toBe(2);
  });

  it("tolerates a half-written final line, because the log is appended to while it is read", () => {
    const report = summarizeRunLog(
      line({ event_type: "intake.complete" }) + "\n" + '{"event_type": "plan.comp',
    );
    expect(report.stagesDone).toBe(1);
    expect(report.stage).toBe(PROGRESS_STAGES.planning);
  });

  it("reads CRLF line endings, which is what the Python writer produces on Windows", () => {
    // Confirmed against this machine's own live-run logs: 30 CR for 30 LF,
    // because `open(..., encoding="utf-8")` in text mode translates "\n" to
    // os.linesep. A bare split("\n") leaves a trailing "\r" on every line.
    //
    // HONEST LIMIT OF THIS TEST, measured rather than assumed: no single line
    // of the implementation can be removed to fail it, because `JSON.parse`
    // already tolerates a trailing "\r" — deleting the `trim()` leaves this
    // green. It is a platform-fact guard: it fails if a future reader becomes
    // CRLF-sensitive (a `/\}$/` line check, a split on os.EOL, a stricter
    // parser), which is a regression nothing else here would catch.
    const report = summarizeRunLog([
      line({ event_type: "intake.complete" }),
      line({ event_type: "plan.complete" }),
      "",
    ].join("\r\n"));

    expect(report.stagesDone).toBe(2);
    expect(report.stage).toBe(PROGRESS_STAGES.design);
  });

  it("walks the stage ladder in the pipeline's own order", () => {
    const upTo = (n: number) => summarizeRunLog(
      PRELUDE_STAGES.slice(0, n).map((type) => line({ event_type: type })).join("\n"),
    ).stage;
    expect(upTo(0)).toBe(PROGRESS_STAGES.starting);
    expect(upTo(1)).toBe(PROGRESS_STAGES.planning);   // intake done -> planning
    expect(upTo(2)).toBe(PROGRESS_STAGES.design);     // plan done -> design system
    expect(upTo(3)).toBe(PROGRESS_STAGES.design);     // tokens done -> still design system
    expect(upTo(4)).toBe(PROGRESS_STAGES.shell);      // primitives done -> app shell
    expect(upTo(5)).toBe(PROGRESS_STAGES.sections);   // shell done -> sections
  });

  it("lists an unrecognised event in the timeline without letting it move a counter", () => {
    const report = summarizeRunLog([
      line({ event_type: "intake.complete" }),
      line({ event_type: "model_call.retried" }),
    ].join("\n"));

    expect(report.stagesDone).toBe(1);
    expect(report.events.map((e) => e.type)).toEqual(["intake.complete", "model_call.retried"]);
    expect(report.events[0]?.at).toEqual(expect.any(String));
  });

  it("returns only type and timestamp per event, never the prompts or raw output the log carries", () => {
    // A run-log event holds the full rendered system and user prompts, the raw
    // model output and per-call usage — hundreds of KB per run. None of it
    // belongs in a response polled every few seconds.
    const report = summarizeRunLog(line({
      event_type: "section.generated",
      section: "home.hero",
      system_prompt: "SYSTEM-PROMPT-MARKER",
      user_prompt: "USER-PROMPT-MARKER",
      raw_output: "RAW-OUTPUT-MARKER",
      usage: { input_tokens: 10 },
    }));

    expect(report.events).toEqual([{ type: "section.generated", at: expect.any(String) }]);
    expect(JSON.stringify(report)).not.toContain("MARKER");
  });

  it("trims the timeline to the last MAX_PROGRESS_EVENTS while still counting every line", () => {
    const many = [
      line({ event_type: "intake.complete" }),
      ...Array.from({ length: MAX_PROGRESS_EVENTS + 10 }, (_unused, i) =>
        line({ event_type: "section.generated", section: `home.s${i}` })),
    ].join("\n");

    const report = summarizeRunLog(many);

    expect(report.events).toHaveLength(MAX_PROGRESS_EVENTS);
    // Counts are over the WHOLE log, not over the trimmed timeline.
    expect(report.sectionsGenerated).toBe(MAX_PROGRESS_EVENTS + 10);
    expect(report.stagesDone).toBe(1);
  });

  it("answers an empty log with the not-started report", () => {
    expect(summarizeRunLog("")).toMatchObject({
      stage: PROGRESS_STAGES.starting, stagesDone: 0, sectionsGenerated: 0, sectionsTotal: null, events: [],
    });
  });
});

describe("the run-log directory", () => {
  const orchestratorDir = fileURLToPath(new URL("../../orchestrator", import.meta.url));

  it("defaults to the orchestrator's own runlog/ directory", () => {
    expect(defaultRunlogDir({})).toBe(resolve(orchestratorDir, "runlog"));
  });

  it("honours ORCHESTRATOR_RUNLOG_DIR, because the orchestrator child inherits it from this process", () => {
    // buildAgentEnv hands the child a COPY of this process's environment, so an
    // operator who moves the child's logs moves them for the server too. A
    // server that ignored this would report zero progress forever.
    expect(defaultRunlogDir({ [ORCHESTRATOR_RUNLOG_DIR_ENV_VAR]: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    // An empty value is not a value — it would resolve to the process's CWD.
    expect(defaultRunlogDir({ [ORCHESTRATOR_RUNLOG_DIR_ENV_VAR]: "" })).toBe(resolve(orchestratorDir, "runlog"));
  });

  it("pins the derivation against the orchestrator's own source, so editing runlog_dir() fails here", () => {
    // The Python side is the authority; this package only DERIVES its
    // expectation. Same "two languages, one contract, one machine-checked pin"
    // shape job-worker.test.ts uses for GENERATED_DIR.
    const configSource = readFileSync(join(orchestratorDir, "src", "orchestrator", "config.py"), "utf8");
    const match = /os\.environ\.get\("([A-Z_]+)", ORCHESTRATOR_ROOT \/ "([^"]+)"\)/.exec(configSource);
    expect(match, "config.py no longer defines runlog_dir() as ORCHESTRATOR_RUNLOG_DIR else ORCHESTRATOR_ROOT / \"<name>\"").not.toBe(null);
    expect(match![1]).toBe(ORCHESTRATOR_RUNLOG_DIR_ENV_VAR);
    expect(defaultRunlogDir({})).toBe(resolve(orchestratorDir, match![2]!));
  });
});
