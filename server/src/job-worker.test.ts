// server/src/job-worker.test.ts
/**
 * Drives the real, unmocked `forwardToPreview` + `proxyHttp` behind a real
 * loopback listener standing in for a project's preview child — same reason
 * preview-forward.test.ts gives for its own choice not to mock sockets: only
 * a real exchange can prove the completion-gated ingest actually behaves,
 * not merely that this module calls the right functions.
 */
import * as http from "node:http";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { usageLogPathFor, USAGE_ID_HEADER } from "../../compiler/src/usage-log-path.ts";
import { DisabledUserError, MissingApiKeyError } from "./agent-env.ts";
import { setApiKey, UndecryptableApiKeyError } from "./api-keys.ts";
import { openDatabase } from "./db.ts";
import { exchangeOverLoopback, JobWorker, LOOPBACK_TOKEN_HEADER, orchestratorGeneratedDir } from "./job-worker.ts";
import { claimNextJob, createJob, finishJob, findJobById, recordJobRun } from "./jobs.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";
import { createProject, type Project } from "./projects.ts";
import type { PreviewPool, PreviewProcess } from "./preview-pool.ts";
import { createUser, type User } from "./users.ts";

const MASTER_KEY = Buffer.alloc(32, 9);
const NOW = 1_800_000_000_000;

/**
 * The repo's own `generated/`, derived from THIS FILE's location rather than
 * by calling `orchestratorGeneratedDir` — deliberately an independent
 * derivation, so the "refuses to construct when they disagree" tests below
 * are not merely comparing the implementation to itself.
 */
const PROJECTS_ROOT = fileURLToPath(new URL("../../generated", import.meta.url));

/**
 * The three `generate` tests that spawn a FAKE orchestrator point
 * `orchestratorDir` somewhere that does not exist, so their projects root has
 * to be that fake directory's own sibling `generated/` — the same relationship
 * the real pair has. Spelled out as two constants rather than one derived from
 * the other precisely so the relationship stays visible: change one and the
 * constructor refuses, which is the whole point of the check.
 */
const FAKE_ORCHESTRATOR_DIR = "/fake/orchestrator/dir";
const FAKE_PROJECTS_ROOT = "/fake/orchestrator/generated";

let dir: string;
let db: DatabaseSync;
let user: User;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-worker-"));
  db = openDatabase(join(dir, "identity.db"));
  user = createUser(db, "a@example.com", "hash");
  project = createProject(db, user.id, "run-a", "Run A");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Same idiom preview-forward.test.ts / preview-proxy.test.ts use. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true within timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Just enough of PreviewPool's surface for job-worker.ts to call — same
 * idiom preview-forward.test.ts's own fakePool uses. No `reserveBillableSlot`/
 * `releaseBillableSlot` here: job-worker.ts no longer calls either (the
 * per-user bound moved into `jobs.ts`'s `claimNextJob` itself — see that
 * function's own comment), so a fake that still offered them would be
 * testing a mechanism this module doesn't use.
 */
function fakePool(overrides: Record<string, unknown> = {}): PreviewPool & {
  acquire: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    acquire: vi.fn(async (): Promise<PreviewProcess> => ({
      projectId: project.id, port: 0, base: "/", inFlight: 0, lastUsedAt: Date.now(),
    })),
    retain: vi.fn(),
    release: vi.fn(),
    // Whole-branch review, CRITICAL 2: `runProxiedJob` re-checks the user's
    // API key at CLAIM time for every billable kind. The real method throws
    // on a missing/disabled/undecryptable key and returns nothing otherwise —
    // this default is the "key is fine" case, which is what every
    // pre-existing test in this file assumes.
    assertApiKeyUsable: vi.fn(),
    ...overrides,
  } as unknown as PreviewPool & {
    acquire: ReturnType<typeof vi.fn>;
    retain: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        port: address.port,
        // `closeAllConnections()` before `close()`, same as
        // preview-forward.test.ts's own upstream cleanup: a test whose own
        // assertion fails (or whose perturbation leaves a connection
        // deliberately open, as in the stop()-awaits-in-flight test) must
        // not also hang the SUITE waiting for a connection nothing will ever
        // finish — that would turn a clean assertion failure into an opaque
        // 30s timeout instead.
        close: async () => { server.closeAllConnections(); server.close(); await once(server, "close"); },
      });
    });
  });
}

describe("JobWorker: proxied kinds", () => {
  it("calls the pool and proxies the recorded body to the child", async () => {
    let received: { method: string | undefined; url: string | undefined; body: string; headers: http.IncomingHttpHeaders } | undefined;
    const upstream = await startUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received = { method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8"), headers: req.headers };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ passed: true, sectionId: "home.hero" }));
      });
    });

    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const requestJson = JSON.stringify({ section: "home.hero", instruction: "make it bigger" });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson, now: NOW });

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    const ran = await worker.runOnce();

    try {
      expect(ran).toBe(true);
      expect(received?.method).toBe("POST");
      expect(received?.url).toBe("/__regen");
      expect(received?.body).toBe(requestJson);
      // The header the child receives selects where its usage log goes —
      // proves the usage id was actually generated and forwarded, not just
      // that SOME request arrived.
      expect(received?.headers[USAGE_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);

      expect(pool.acquire).toHaveBeenCalledWith(project, user.id);
      expect(pool.retain).toHaveBeenCalledWith(project.id);
      expect(pool.release).toHaveBeenCalledWith(project.id);

      const finished = findJobById(db, job.id);
      expect(finished?.status).toBe("succeeded");
      expect(finished?.resultJson).toBe(JSON.stringify({ passed: true, sectionId: "home.hero" }));
      expect(finished?.error).toBe(null);
    } finally {
      await upstream.close();
    }
  });

  it("stamps run_id (the project's directory) and codeVersion on the job before the exchange runs (task 7, resume)", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW, codeVersion: "sha-fixed-for-test" });
    try {
      await worker.runOnce();
      const finished = findJobById(db, job.id);
      expect(finished?.runId).toBe(project.directory);
      expect(finished?.codeVersion).toBe("sha-fixed-for-test");
    } finally {
      await upstream.close();
    }
  });

  it("uses the job's ALREADY-SET runId (a resumed job) instead of re-deriving it from project.directory, even though they are always equal in practice", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW,
      runId: "web-a-preset-run-id",
    });

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    try {
      await worker.runOnce();
      expect(findJobById(db, job.id)?.runId).toBe("web-a-preset-run-id");
    } finally {
      await upstream.close();
    }
  });

  it("marks a failed proxy exchange as a failed job with a redacted error, and still releases", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gate 3 failed near key sk-ant-ABCDEFGHIJ0123456789xyz" }));
    });

    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "add-section", requestJson: "{}", now: NOW,
    });

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    const ran = await worker.runOnce();

    try {
      expect(ran).toBe(true);
      const finished = findJobById(db, job.id);
      expect(finished?.status).toBe("failed");
      expect(finished?.resultJson).toBe(null);
      expect(finished?.error).toBe("gate 3 failed near key sk-ant-[redacted]");
      expect(finished?.error).not.toMatch(/sk-ant-ABCDEFGHIJ0123456789xyz/);
      // Released even though the exchange failed -- a leaked pool slot on
      // every failure would starve capacity fast.
      expect(pool.release).toHaveBeenCalledWith(project.id);
    } finally {
      await upstream.close();
    }
  });

  /**
   * Task-3-review finding 2: task 3's own report claimed this property
   * ("a failed run is still billed" -- binding constraint 5's most important
   * half) moved into this file, but it never actually did — the test above
   * ("marks a failed proxy exchange...") asserts status/redaction/release
   * only, and writes no usage log, so `ingestUsageLog` runs against nothing
   * and the assertion that would catch a regression here (a `usage_event`
   * row existing) was simply absent. This is that missing assertion, ported
   * for real: the upstream writes a usage log BEFORE answering with a
   * failure status, exactly like a run that spent real money on the stages
   * it got through before failing partway through the next one.
   * `forwardToPreview`'s own `completed` gate (preview-forward.ts) is about
   * whether the exchange itself finished, never about the HTTP status code
   * it finished with — a clean error response is just as "completed" as a
   * clean success one, so ingest must still run.
   */
  it("still ingests the usage log — and bills the user — when the proxy exchange itself fails, not merely when it succeeds", async () => {
    let capturedUsageId: string | undefined;
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      capturedUsageId = Array.isArray(raw) ? raw[0] : raw;
      writeFileSync(
        usageLogPathFor(capturedUsageId!),
        JSON.stringify({
          timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
          input_tokens: 40, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          cost_usd: 0.34,
        }),
        "utf8",
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gate 4 failed partway through" }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("failed");

      // The load-bearing assertion this finding exists for: spend survives
      // the failure.
      const row = db.prepare("SELECT COUNT(*) AS c FROM usage_event WHERE user_id = ?").get(user.id) as { c: number };
      expect(row.c).toBe(1);
      expect(existsSync(usageLogPathFor(capturedUsageId!))).toBe(false);
    } finally {
      await upstream.close();
    }
  });

  it("requeues (does not fail) a job when the pool answers 503 (capacity)", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "preview capacity reached: at most 6 preview processes may run at once" }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen-page", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(false);
      const found = findJobById(db, job.id);
      expect(found?.status).toBe("queued");
      expect(found?.error).toBe(null);
    } finally {
      await upstream.close();
    }
  });

  it("ingests the usage log for a completed exchange, and deletes it", async () => {
    let capturedUsageId: string | undefined;
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      capturedUsageId = Array.isArray(raw) ? raw[0] : raw;
      // Stand in for the child actually writing a usage log before answering.
      writeFileSync(
        usageLogPathFor(capturedUsageId!),
        JSON.stringify({
          timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
          input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          cost_usd: 0.12,
        }),
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      await worker.runOnce();
      expect(capturedUsageId).toMatch(/^[0-9a-f]{32}$/);
      const row = db.prepare("SELECT COUNT(*) AS c FROM usage_event WHERE user_id = ?").get(user.id) as { c: number };
      expect(row.c).toBe(1);
      expect(existsSync(usageLogPathFor(capturedUsageId!))).toBe(false);
    } finally {
      await upstream.close();
    }
  });

  /**
   * Task-3-review finding 3: the deleted "...a different one per request"
   * asserted `id1 !== id2` across two requests. The single-job test above
   * only proves the SHAPE of one id (`/^[0-9a-f]{32}$/`), which a constant
   * string or a reused id would satisfy just as well — this drives two
   * separate jobs and compares. A constant or reused id would make two
   * concurrent jobs share one usage-log PATH: the second job's write would
   * land in (or delete) the first's file, so one user's spend event gets
   * double-counted while the other's silently vanishes, and nothing else
   * here would catch it.
   */
  it("generates a DIFFERENT usage id per job — not a constant or reused one", async () => {
    const capturedIds: string[] = [];
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (id !== undefined) capturedIds.push(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW + 1 });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      expect(await worker.runOnce()).toBe(true); // first job, claimed+run+finished
      expect(await worker.runOnce()).toBe(true); // second job, likewise
      expect(capturedIds).toHaveLength(2);
      expect(capturedIds[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(capturedIds[1]).toMatch(/^[0-9a-f]{32}$/);
      expect(capturedIds[0]).not.toBe(capturedIds[1]);
    } finally {
      await upstream.close();
    }
  });

  /**
   * Ported from compiler-routes.test.ts (pre-slice-5): that file used to
   * test this directly against `billableForward`'s wiring, which moved,
   * unchanged in shape, into THIS module's own `after` hook (see this
   * module's top comment). Deleting the old test without this replacement
   * would have been a real coverage regression — `ingestUsageLog`'s own
   * docstring says `skipped`/`unreadable` exist "precisely so the caller can
   * log them," and this is the only place left that could catch a caller
   * that stopped doing so.
   */
  it("logs a warning naming the user and project when the ingest loses spend (skipped > 0)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let capturedUsageId: string | undefined;
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      capturedUsageId = Array.isArray(raw) ? raw[0] : raw;
      // One valid row and one row missing model/role: ingest-usage.ts counts
      // the second as `skipped`, not a throw — exactly the "lost spend, but
      // silently" shape this warning exists to surface.
      writeFileSync(
        usageLogPathFor(capturedUsageId!),
        [
          JSON.stringify({
            timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
            input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            cost_usd: 1,
          }),
          JSON.stringify({ bogus: true }),
        ].join("\n"),
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(user.id);
      expect(logged).toContain(project.id);
      expect(logged).toMatch(/skipped/i);
    } finally {
      errorSpy.mockRestore();
      await upstream.close();
    }
  });

  it("logs a warning naming the user and project when the usage log is unreadable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let dirPath: string | undefined;
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      const usageId = Array.isArray(raw) ? raw[0] : raw;
      // A directory at the log's path: exists, but unreadable as a file --
      // the same trick ingest-usage.test.ts uses for this exact case.
      dirPath = usageLogPathFor(usageId!);
      mkdirSync(dirPath, { recursive: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "add-section", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(user.id);
      expect(logged).toContain(project.id);
      expect(logged).toMatch(/unreadable/i);
    } finally {
      errorSpy.mockRestore();
      if (dirPath !== undefined) rmSync(dirPath, { recursive: true, force: true });
      await upstream.close();
    }
  });

  /**
   * Task-3-review finding 4: these two negative tests were deleted from
   * compiler-routes.test.ts with no replacement anywhere — only the two
   * POSITIVE (`skipped`/`unreadable`) cases above were ported. Operator log
   * noise on every successful billable job is the stated reason
   * `runProxiedJob`'s own `after` hook stays silent on a clean ingest (see
   * job-worker.ts's module comment quoting ingest-usage.ts's docstring) —
   * without these, a future change that logged unconditionally (or on any
   * ingest at all, not just a lossy one) would pass every other test in this
   * file, since none of them assert the ABSENCE of a log line on the happy
   * path.
   */
  it("logs nothing when the ingest is clean (rows recorded, nothing lost)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = await startUpstream((req, res) => {
      const raw = req.headers[USAGE_ID_HEADER];
      const usageId = Array.isArray(raw) ? raw[0] : raw;
      writeFileSync(
        usageLogPathFor(usageId!),
        [
          JSON.stringify({
            timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
            input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            cost_usd: 1,
          }),
          JSON.stringify({
            timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
            input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            cost_usd: 2,
          }),
        ].join("\n"),
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await upstream.close();
    }
  });

  it("logs nothing when the child wrote no usage log at all (the legitimate no-op)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = await startUpstream((_req, res) => {
      // Deliberately writes no usage log for any id -- the legitimate
      // "this request made no model calls" case.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "add-section", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await upstream.close();
    }
  });

  it("skips ingest (and leaves the usage log on disk) when the exchange times out — an incomplete exchange", async () => {
    let capturedCallback: (() => void) | undefined;
    const spy = vi.spyOn(http.ClientRequest.prototype, "setTimeout")
      .mockImplementation(function (this: http.ClientRequest, _ms: number, cb?: () => void) {
        capturedCallback = cb;
        return this;
      });

    let capturedUsageId: string | undefined;
    let requestReceived = false;
    const upstream = await startUpstream((req) => {
      const raw = req.headers[USAGE_ID_HEADER];
      capturedUsageId = Array.isArray(raw) ? raw[0] : raw;
      writeFileSync(
        usageLogPathFor(capturedUsageId!),
        JSON.stringify({
          timestamp: new Date(NOW).toISOString(), role: "section", model: "claude-sonnet-5",
          input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          cost_usd: 0.01,
        }),
        "utf8",
      );
      requestReceived = true;
      // Deliberately never responds.
    });

    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    try {
      const runPromise = worker.runOnce();
      await waitUntil(() => requestReceived);
      await waitUntil(() => capturedCallback !== undefined);
      capturedCallback!(); // fires PREVIEW_PROXY_TIMEOUT_MS's own handler -> 504, completed:false

      const ran = await runPromise;
      expect(ran).toBe(true); // reached a terminal state (failed), not requeued
      const finished = findJobById(db, job.id);
      expect(finished?.status).toBe("failed");
      expect(finished?.error).toBe("preview upstream timed out");

      // The load-bearing assertion: ingest never ran for an incomplete
      // exchange, so the file the child wrote is still sitting there and no
      // usage_event row exists for it.
      expect(existsSync(usageLogPathFor(capturedUsageId!))).toBe(true);
      const row = db.prepare("SELECT COUNT(*) AS c FROM usage_event WHERE user_id = ?").get(user.id) as { c: number };
      expect(row.c).toBe(0);

      expect(pool.release).toHaveBeenCalledWith(project.id);
    } finally {
      spy.mockRestore();
      rmSync(usageLogPathFor(capturedUsageId ?? "0".repeat(32)), { force: true });
      await upstream.close();
    }
  });
});

describe("JobWorker: per-user bound (enforced by claimNextJob, not this module)", () => {
  it("does not run a job for a user already at the running limit; runs a different, eligible user's job instead", async () => {
    // The exact scenario the coordinator's fix asked to be proven at the
    // worker level, not only inside jobs.test.ts's unit tests: two users,
    // one at their limit, and the OTHER user's job is what actually runs.
    const otherUser = createUser(db, "e@example.com", "hash");
    const otherProject = createProject(db, otherUser.id, "run-other", "Run Other");

    createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW + 1 });
    claimNextJob(db, NOW + 10); // -> running #1 for `user`
    claimNextJob(db, NOW + 11); // -> running #2 for `user`, now at the limit

    // Oldest QUEUED job overall -- would win under plain FIFO, but `user` is
    // at the limit, so it must be skipped.
    const blockedThird = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW + 5,
    });
    // Newer, but belongs to a user with nothing running.
    const eligible = createJob(db, {
      userId: otherUser.id, projectId: otherProject.id, kind: "regen", requestJson: "{}", now: NOW + 20,
    });

    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: otherProject.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW + 30 });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(findJobById(db, eligible.id)?.status).toBe("succeeded");
      // The load-bearing assertion: still exactly `queued`, never
      // claimed-and-requeued (the old, starvation-prone behavior).
      const found = findJobById(db, blockedThird.id);
      expect(found?.status).toBe("queued");
      expect(found?.startedAt).toBe(null);
    } finally {
      await upstream.close();
    }
  });
});

describe("JobWorker: stop()", () => {
  it("awaits the currently in-flight job rather than abandoning it", async () => {
    let requestReceived = false;
    let finishWork!: () => void;
    const workDone = new Promise<void>((resolve) => { finishWork = resolve; });
    const upstream = await startUpstream((_req, res) => {
      requestReceived = true;
      void workDone.then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ passed: true }));
      });
    });

    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, pollIntervalMs: 5, now: () => NOW });

    try {
      worker.start();
      await waitUntil(() => requestReceived);

      let stopped = false;
      const stopPromise = worker.stop().then(() => { stopped = true; });

      // A macrotask boundary flushes anything that could have resolved
      // synchronously-ish; workDone cannot resolve until finishWork() is
      // called below, so stop() structurally cannot have resolved yet.
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(findJobById(db, job.id)?.status).toBe("running");

      finishWork();
      await stopPromise;
      expect(stopped).toBe(true);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
    } finally {
      await upstream.close();
    }
  });

  it("start() is idempotent and stop() is safe to call with nothing running", async () => {
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, pollIntervalMs: 5, now: () => NOW });
    worker.start();
    worker.start(); // second call must not arm a second interval
    await worker.stop();
    await worker.stop(); // idempotent
  });
});

describe("JobWorker: generate", () => {
  function fakeOrchestratorChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }

  it("spawns the orchestrator with buildAgentEnv's environment, WEBGEN_USAGE_LOG set, and redacts stdout", async () => {
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-REALSECRETKEY0123456789");
    const genProject = createProject(db, user.id, "run-gen", "Run Gen");

    let spawnedCommand: string | undefined;
    let spawnedArgs: string[] | undefined;
    let spawnedOptions: { cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const child = fakeOrchestratorChild();
    const orchestratorSpawnFn = vi.fn((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      spawnedCommand = command;
      spawnedArgs = args;
      spawnedOptions = options;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`leaked key sk-ant-REALSECRETKEY0123456789 in stdout\n`));
        child.emit("exit", 0);
      });
      return child;
    });

    const requestJson = JSON.stringify({ brief: "a bakery landing page" });
    const job = createJob(db, { userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW });
    const pool = fakePool();
    const worker = new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: FAKE_PROJECTS_ROOT, now: () => NOW,
      orchestratorDir: FAKE_ORCHESTRATOR_DIR,
      orchestratorSpawnFn,
    });

    const ran = await worker.runOnce();
    expect(ran).toBe(true);

    expect(spawnedCommand).toBe("uv");
    expect(spawnedArgs).toEqual([
      "run", "python", "-m", "orchestrator.acceptance", "--brief", "a bakery landing page", "--run-id", "run-gen",
    ]);
    expect(spawnedOptions?.cwd).toBe("/fake/orchestrator/dir");
    expect(spawnedOptions?.env.ANTHROPIC_API_KEY).toBe("sk-ant-REALSECRETKEY0123456789");
    expect(spawnedOptions?.env[MASTER_KEY_ENV_VAR]).toBeUndefined();
    expect(spawnedOptions?.env.WEBGEN_USAGE_LOG).toMatch(/webgen-usage[\\/][0-9a-f]{32}\.jsonl$/);

    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.resultJson).not.toContain("sk-ant-REALSECRETKEY0123456789");
    expect(finished?.resultJson).toContain("sk-ant-[redacted]");
    // Task 7 (resume): stamped BEFORE the spawn, so a job that then fails
    // still records what it actually ran under.
    expect(finished?.runId).toBe("run-gen");
    expect(finished?.codeVersion).toBeTypeOf("string");
    expect(finished?.codeVersion).not.toBe(null);
  });

  it("passes a RESUMED job's already-set runId as --run-id, instead of re-deriving project.directory (task 7)", async () => {
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-REALSECRETKEY0123456789");
    // Task-7-review finding 2: the project's OWN directory and the preset
    // runId must be DIFFERENT values. When both happened to equal
    // "run-gen-resume", reverting job-worker.ts's `"--run-id", runId` back
    // to `"--run-id", project.directory` left this test green — checked by
    // hand, and confirmed to fail correctly with these two now distinct.
    const genProject = createProject(db, user.id, "run-gen-fresh-dir", "Run Gen Resume");

    let spawnedArgs: string[] | undefined;
    const child = fakeOrchestratorChild();
    const orchestratorSpawnFn = vi.fn((_command: string, args: string[]) => {
      spawnedArgs = args;
      setImmediate(() => child.emit("exit", 0));
      return child;
    });

    const requestJson = JSON.stringify({ brief: "a bakery landing page" });
    const originalFailedJob = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW - 1,
    });
    // Terminal, and OLDER than `job` below (claimNextJob claims oldest-queued
    // first) — must not itself be eligible for claiming, or this test would
    // exercise the wrong row entirely.
    finishJob(db, originalFailedJob.id, { status: "failed", error: "boom", now: NOW - 1 });
    // Simulates what job-routes.ts's resume handler does: a NEW job row
    // carrying the ORIGINAL failed job's own runId verbatim, which need not
    // equal this (new) job's own project.directory-derived default — and
    // here DELIBERATELY does not, so the two are distinguishable.
    const job = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW,
      runId: "run-gen-older-run", resumedFromJobId: originalFailedJob.id,
    });
    const pool = fakePool();
    const worker = new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: FAKE_PROJECTS_ROOT, now: () => NOW,
      orchestratorDir: FAKE_ORCHESTRATOR_DIR,
      orchestratorSpawnFn,
      codeVersion: "sha-for-this-test",
    });

    const ran = await worker.runOnce();
    expect(ran).toBe(true);
    expect(spawnedArgs).toContain("--run-id");
    expect(spawnedArgs?.at(-1)).toBe("run-gen-older-run");
    expect(spawnedArgs?.at(-1)).not.toBe(genProject.directory);

    const finished = findJobById(db, job.id);
    expect(finished?.runId).toBe("run-gen-older-run");
    expect(finished?.codeVersion).toBe("sha-for-this-test");
    // recordJobRun's OWN job-run fields, not the (unrelated) resume link:
    // that link is set once, at enqueue, by job-routes.ts — job-worker.ts
    // must never touch it.
    expect(finished?.resumedFromJobId).toBe(originalFailedJob.id);
  });

  it("marks the job failed with a redacted, bounded message on a nonzero exit code", async () => {
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-ANOTHERSECRET987654321");
    const genProject = createProject(db, user.id, "run-gen-fail", "Run Gen Fail");
    const child = fakeOrchestratorChild();
    const orchestratorSpawnFn = vi.fn(() => {
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("StageError: fanout failed, key sk-ant-ANOTHERSECRET987654321 leaked\n"));
        child.emit("exit", 1);
      });
      return child;
    });
    const requestJson = JSON.stringify({ brief: "a broken site" });
    const job = createJob(db, { userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW });
    const pool = fakePool();
    const worker = new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: FAKE_PROJECTS_ROOT, now: () => NOW,
      orchestratorDir: FAKE_ORCHESTRATOR_DIR,
      orchestratorSpawnFn,
    });

    const ran = await worker.runOnce();
    expect(ran).toBe(true);
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.resultJson).toBe(null);
    expect(finished?.error).toContain("orchestrator exited with code 1");
    expect(finished?.error).toContain("sk-ant-[redacted]");
    expect(finished?.error).not.toContain("sk-ant-ANOTHERSECRET987654321");
  });

  it("fails cleanly (never throws out of runOnce) when the request payload has no brief", async () => {
    const genProject = createProject(db, user.id, "run-gen-nobrief", "Run Gen No Brief");
    const job = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate", requestJson: JSON.stringify({}), now: NOW,
    });
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    const ran = await worker.runOnce();
    expect(ran).toBe(true);
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("a brief is required");
  });
});

describe("JobWorker: resumed job safety checks (task-7-review findings 3 and 5)", () => {
  /**
   * Finding 3: job-routes.ts's resume endpoint only checks code-version
   * compatibility at ENQUEUE time. A resumed job can then sit `queued` for
   * minutes (bound of 2 concurrent per user; a `generate` run measures
   * ~286s), surviving a restart untouched (`markRunningJobsInterrupted`
   * converts only `running` rows). If a deploy changing a checkpoint's body
   * lands while it waits, nothing re-checks it — `runOnce` must, right after
   * claiming, before either execution strategy runs.
   */
  it("fails a resumed PROXIED job immediately, without touching the pool, when the ORIGINAL job's code_version is incompatible with this worker's own", async () => {
    const originalFailedJob = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW - 1,
    });
    recordJobRun(db, originalFailedJob.id, { runId: "web-x", codeVersion: "OLD-sha-before-a-deploy" });
    finishJob(db, originalFailedJob.id, { status: "failed", error: "boom", now: NOW - 1 });

    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW,
      runId: "web-x", resumedFromJobId: originalFailedJob.id,
    });
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW, codeVersion: "NEW-sha-after-a-deploy" });

    const ran = await worker.runOnce();

    expect(ran).toBe(true);
    expect(pool.acquire).not.toHaveBeenCalled();
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("server code changed");
    // Never actually ran, so recordJobRun never touched this job's own
    // fields — runId stays exactly what it was pre-set to at creation, and
    // codeVersion (which ONLY recordJobRun ever writes) stays null.
    expect(finished?.runId).toBe("web-x");
    expect(finished?.codeVersion).toBe(null);
  });

  it("fails a resumed GENERATE job immediately, without spawning the orchestrator, on the identical incompatibility", async () => {
    const genProject = createProject(db, user.id, "run-gen-guard", "Run Gen Guard");
    const requestJson = JSON.stringify({ brief: "a bakery landing page" });
    const originalFailedJob = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW - 1,
    });
    recordJobRun(db, originalFailedJob.id, { runId: "run-gen-guard", codeVersion: "OLD-sha" });
    finishJob(db, originalFailedJob.id, { status: "failed", error: "boom", now: NOW - 1 });

    const job = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate", requestJson, now: NOW,
      runId: "run-gen-guard", resumedFromJobId: originalFailedJob.id,
    });
    const orchestratorSpawnFn = vi.fn();
    const pool = fakePool();
    const worker = new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW, orchestratorSpawnFn, codeVersion: "NEW-sha",
    });

    const ran = await worker.runOnce();

    expect(ran).toBe(true);
    expect(orchestratorSpawnFn).not.toHaveBeenCalled();
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("server code changed");
  });

  it("runs normally when the ORIGINAL job's code_version matches this worker's own — the safe-resume path stays open", async () => {
    const originalFailedJob = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW - 1,
    });
    recordJobRun(db, originalFailedJob.id, { runId: "web-x", codeVersion: "sha-1" });
    finishJob(db, originalFailedJob.id, { status: "failed", error: "boom", now: NOW - 1 });

    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW,
      runId: "web-x", resumedFromJobId: originalFailedJob.id,
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW, codeVersion: "sha-1" });

    try {
      const ran = await worker.runOnce();
      expect(ran).toBe(true);
      expect(pool.acquire).toHaveBeenCalled();
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
    } finally {
      await upstream.close();
    }
  });

  /**
   * Finding 5: `run_id` flows into a filesystem path downstream
   * (`GENERATED_DIR / run_id`, `basename(root)`) — the identical shape the
   * 4c-2 review found already exploited once via an unvalidated `..`-bearing
   * field. Unreachable today (run_id is always a `web-<uuid>` this process
   * generates, or copied from an earlier job that already passed this same
   * check), but the guard must fail the job CLEANLY, not leave it stuck
   * `running` behind an uncaught throw out of `recordJobRun`.
   */
  it("fails a job cleanly (not stuck 'running', no uncaught throw) when its runId has an unsafe shape", async () => {
    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW,
      runId: "../../etc/passwd",
    });
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });

    const ran = await worker.runOnce();

    expect(ran).toBe(true);
    expect(pool.acquire).not.toHaveBeenCalled();
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("unsafe shape");
  });

  it("fails a GENERATE job cleanly on the identical unsafe runId shape, without spawning the orchestrator", async () => {
    const genProject = createProject(db, user.id, "run-gen-unsafe", "Run Gen Unsafe");
    const job = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate",
      requestJson: JSON.stringify({ brief: "a bakery landing page" }), now: NOW,
      runId: "not/a/safe/run/id",
    });
    const orchestratorSpawnFn = vi.fn();
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW, orchestratorSpawnFn });

    const ran = await worker.runOnce();

    expect(ran).toBe(true);
    expect(orchestratorSpawnFn).not.toHaveBeenCalled();
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("unsafe shape");
  });
});

describe("JobWorker: nothing queued", () => {
  it("runOnce() returns false and does nothing when the queue is empty", async () => {
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    const ran = await worker.runOnce();
    expect(ran).toBe(false);
    expect(pool.acquire).not.toHaveBeenCalled();
  });
});

// Sanity: claimNextJob really is the atomic primitive this module relies on
// to never double-run a job — see jobs.test.ts for the full proof; this just
// confirms job-worker.ts imports and uses the same one, not a shadow copy.
describe("JobWorker: uses jobs.ts's own claimNextJob", () => {
  it("a job claimed directly via claimNextJob is not claimed again by runOnce()", async () => {
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    claimNextJob(db, NOW + 1); // claims it out from under the worker
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW + 2 });
    const ran = await worker.runOnce();
    expect(ran).toBe(false);
    expect(findJobById(db, job.id)?.status).toBe("running"); // untouched by this worker
    expect(pool.acquire).not.toHaveBeenCalled();
  });
});

/**
 * WHOLE-BRANCH REVIEW, CRITICAL 1 — "a generation writes its site where
 * nothing looks for it."
 *
 * `scripts/serve.ts --projects-root <X>` decides where the server creates,
 * previews, adopts and exports a project; `orchestrator.acceptance` writes
 * into its OWN hardcoded `GENERATED_DIR` and accepts no output-directory
 * argument. When those disagree, a ~400s, ~$1.09 generation still finishes
 * `succeeded` and the resulting site is unreachable. These tests are the
 * "must fail if the two paths diverge again" requirement: the first two cover
 * an operator-supplied divergence, the third covers a divergence introduced
 * by editing the Python constant.
 */
describe("JobWorker: projects root must agree with the orchestrator's output directory", () => {
  it("refuses to construct when --projects-root names a different directory, naming both paths", () => {
    const pool = fakePool();
    let thrown: unknown;
    try {
      new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: "/var/lib/webgen", now: () => NOW });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("refused to start");
    // Both RESOLVED paths must appear: the entire class of mistake this
    // catches is an operator not realising which directory a relative
    // --projects-root resolved against, and an error naming neither is
    // useless for that.
    expect(message).toContain(resolve("/var/lib/webgen"));
    expect(message).toContain(PROJECTS_ROOT);
  });

  it("accepts a projects root that resolves to the same directory by a different spelling", () => {
    const pool = fakePool();
    // `<repo>/server/..//generated` is the same directory as `<repo>/generated`
    // — the check compares RESOLVED paths, not strings, so an operator's
    // equivalent-but-differently-spelled value is not a false alarm.
    const equivalent = join(PROJECTS_ROOT, "..", "server", "..", "generated");
    expect(() => new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: equivalent, now: () => NOW,
    })).not.toThrow();
  });

  it("pins the derivation against the orchestrator's own source, so editing GENERATED_DIR fails here", () => {
    // The Python side is the authority; this package only DERIVES its
    // expectation. Nothing else in either language proves the two agree —
    // the same gap `fixtures/usage-log-contract.jsonl` exists to close for
    // the usage log, closed here by reading the constant itself.
    const pipelineSource = readFileSync(
      join(PROJECTS_ROOT, "..", "orchestrator", "src", "orchestrator", "section_pipeline.py"),
      "utf8",
    );
    const match = /^GENERATED_DIR = REPO_ROOT \/ "([^"]+)"$/m.exec(pipelineSource);
    expect(match, "section_pipeline.py no longer defines GENERATED_DIR as REPO_ROOT / \"<name>\"").not.toBe(null);
    const configSource = readFileSync(
      join(PROJECTS_ROOT, "..", "orchestrator", "src", "orchestrator", "config.py"),
      "utf8",
    );
    // REPO_ROOT is `ORCHESTRATOR_ROOT.parent` (section_pipeline.py), and
    // ORCHESTRATOR_ROOT is `Path(__file__).resolve().parents[2]` — the
    // `orchestrator/` package root. Both halves of that chain are pinned, so
    // changing EITHER one fails this test rather than silently invalidating
    // orchestratorGeneratedDir's own "resolve(orchestratorDir, '..', name)".
    expect(configSource).toContain("ORCHESTRATOR_ROOT = Path(__file__).resolve().parents[2]");
    expect(pipelineSource).toContain("REPO_ROOT = ORCHESTRATOR_ROOT.parent");
    const orchestratorDir = join(PROJECTS_ROOT, "..", "orchestrator");
    expect(orchestratorGeneratedDir(orchestratorDir)).toBe(resolve(orchestratorDir, "..", match![1]!));
  });
});

/**
 * WHOLE-BRANCH REVIEW, CRITICAL 2 — "a user can hand their regen bill to the
 * operator."
 *
 * `compiler-routes.ts` checks the key at ENQUEUE. The job model turned the
 * millisecond gap between that check and the run into a job-lifetime one, and
 * every layer below deliberately degrades rather than refuses:
 * `PreviewPool.buildChildEnv` swallows `MissingApiKeyError` and spawns a
 * keyless child, and `config.py`'s `load_dotenv(override=False)` then lets the
 * absent key fall through to `orchestrator/.env` — the OPERATOR's key,
 * recorded against the user's project, with zero `usage_event` rows.
 */
describe("JobWorker: re-checks the API key at claim time for billable kinds", () => {
  /** The three typed failures `PreviewPool.assertApiKeyUsable` can actually raise here. */
  const typedFailures = [
    { name: "missing key", error: () => new MissingApiKeyError() },
    { name: "disabled account", error: () => new DisabledUserError() },
    { name: "undecryptable key", error: () => new UndecryptableApiKeyError() },
  ];

  for (const failure of typedFailures) {
    it(`fails a billable job without ever reaching the preview child — ${failure.name}`, async () => {
      let upstreamHits = 0;
      const upstream = await startUpstream((_req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ passed: true }));
      });
      const pool = fakePool({
        acquire: vi.fn(async (): Promise<PreviewProcess> => ({
          projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
        })),
        assertApiKeyUsable: vi.fn(() => { throw failure.error(); }),
      });
      const job = createJob(db, {
        userId: user.id, projectId: project.id, kind: "regen",
        requestJson: JSON.stringify({ section: "home.hero", instruction: "x" }), now: NOW,
      });

      const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
      const ran = await worker.runOnce();

      try {
        expect(ran).toBe(true);
        const finished = findJobById(db, job.id);
        expect(finished?.status).toBe("failed");
        expect(finished?.error).toBe(failure.error().message);
        // The point of the fix: the run never starts. No child is acquired,
        // nothing is proxied, and so nothing spends the operator's key.
        expect(pool.acquire).not.toHaveBeenCalled();
        expect(upstreamHits).toBe(0);
      } finally {
        await upstream.close();
      }
    });
  }

  it("checks the key against the JOB's own user", async () => {
    const pool = fakePool({ assertApiKeyUsable: vi.fn() });
    const other = createUser(db, "b@example.com", "hash");
    // A project owned by `user`, but a job enqueued by `other` — impossible
    // through the live route table (requireProject would refuse), asserted
    // anyway so the check can never quietly drift onto `project.ownerId`,
    // which is what would let a second account's key pay for this run.
    const job = createJob(db, {
      userId: other.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW,
    });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    await worker.runOnce();
    expect(findJobById(db, job.id)).not.toBe(null);
    expect(pool.assertApiKeyUsable).toHaveBeenCalledWith(other.id);
  });

  it("still runs a NON-billable kind (export) for a user with no key at all", async () => {
    let upstreamHits = 0;
    const upstream = await startUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
      // Would refuse if it were consulted — exporting is deterministic and
      // spends no model money, so it must never be.
      assertApiKeyUsable: vi.fn(() => { throw new MissingApiKeyError(); }),
    });
    const job = createJob(db, {
      userId: user.id, projectId: project.id, kind: "export", requestJson: "{}", now: NOW,
    });

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT, now: () => NOW });
    const ran = await worker.runOnce();

    try {
      expect(ran).toBe(true);
      expect(pool.assertApiKeyUsable).not.toHaveBeenCalled();
      expect(upstreamHits).toBe(1);
      expect(findJobById(db, job.id)?.status).toBe("succeeded");
    } finally {
      await upstream.close();
    }
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING A — the loopback listener that stands in for a
 * browser connection had a FIXED authorized identity and no authentication at
 * all: `forwardToPreview` is closed over one `{user, project}` ctx and
 * forwards `req.url` verbatim, so any local process that connected during a
 * 27s-to-15-minute job got an authenticated, authorized channel into that
 * tenant's Vite child.
 */
describe("exchangeOverLoopback: only the request it drives is authorized", () => {
  it("serves the driven request and 404s a foreign one on the same port, without invoking the handler", async () => {
    let handlerCalls = 0;
    let port = 0;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((res) => { releaseHandler = res; });

    const exchange = exchangeOverLoopback(
      async (req, res) => {
        handlerCalls += 1;
        // The listener's own port, read off the real socket — nothing else
        // exposes it, which is exactly why a foreign process would have to
        // scan for it (and, over a minutes-long job, can).
        port = req.socket.localPort ?? 0;
        await handlerGate;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      "/__regen",
      JSON.stringify({ section: "home.hero" }),
    );

    await waitUntil(() => port !== 0);

    // A second, uninvited request to the SAME live port: this is the attack.
    const foreign = await new Promise<{ status: number }>((resolveForeign, rejectForeign) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/__overrides/home", method: "POST", headers: { "content-type": "application/json" } },
        (res) => { res.resume(); res.on("end", () => resolveForeign({ status: res.statusCode ?? 0 })); },
      );
      req.on("error", rejectForeign);
      req.end("{}");
    });

    expect(foreign.status).toBe(404);
    // The load-bearing half: the foreign request never reached the handler,
    // so it never reached `forwardToPreview`, the pool, or the child.
    expect(handlerCalls).toBe(1);

    releaseHandler!();
    const result = await exchange;
    expect(result.status).toBe(200);
    expect(result.body).toBe(JSON.stringify({ ok: true }));
  });

  it("404s a request presenting a wrong token", async () => {
    let handlerCalls = 0;
    let port = 0;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((res) => { releaseHandler = res; });

    const exchange = exchangeOverLoopback(
      async (req, res) => {
        handlerCalls += 1;
        port = req.socket.localPort ?? 0;
        await handlerGate;
        res.writeHead(200);
        res.end("{}");
      },
      "/__regen",
      "{}",
    );
    await waitUntil(() => port !== 0);

    const foreign = await new Promise<{ status: number }>((resolveForeign, rejectForeign) => {
      const req = http.request(
        {
          hostname: "127.0.0.1", port, path: "/__regen", method: "POST",
          // Right length, wrong value — proves the comparison is on the VALUE,
          // not merely on the header's presence.
          headers: { [LOOPBACK_TOKEN_HEADER]: "0".repeat(32) },
        },
        (res) => { res.resume(); res.on("end", () => resolveForeign({ status: res.statusCode ?? 0 })); },
      );
      req.on("error", rejectForeign);
      req.end();
    });

    expect(foreign.status).toBe(404);
    expect(handlerCalls).toBe(1);
    releaseHandler!();
    await exchange;
  });

  it("does not forward the token on to the handler (and so never to the child)", async () => {
    let seenToken: unknown = "not-read";
    const result = await exchangeOverLoopback(
      (req, res) => {
        seenToken = req.headers[LOOPBACK_TOKEN_HEADER];
        res.writeHead(200);
        res.end("{}");
      },
      "/__regen",
      "{}",
    );
    expect(result.status).toBe(200);
    expect(seenToken).toBeUndefined();
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING C — unbounded shutdown, orphaned child,
 * deleted spend.
 *
 * `stop()` awaited the in-flight tick with no timeout (up to ~400s for a
 * generate, 15 minutes on the proxy timeout), so under any supervisor SIGKILL
 * landed first; the orchestrator child was never tracked and never killed, so
 * it outlived the server, kept spending, and kept appending to a usage log
 * that the next boot's `sweepStaleUsageLogs` unlinks unread.
 */
describe("JobWorker: stop() is bounded and terminates the orchestrator child", () => {
  type FakeChild = EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: NodeJS.Signals) => boolean;
  };

  function fakeChildWith(kill: (signal?: NodeJS.Signals) => boolean): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = kill;
    return child;
  }

  it("returns within its own bound, escalating SIGTERM to SIGKILL, when the child ignores both", async () => {
    const genProject = createProject(db, user.id, "run-gen", "Run Gen");
    // Never exits on its own, and ignores SIGTERM — the worst case, and the
    // one that used to hang stop() forever.
    const kill = vi.fn((_signal?: NodeJS.Signals) => true);
    const child = fakeChildWith(kill);
    let spawned = false;
    const orchestratorSpawnFn = vi.fn(() => { spawned = true; return child; });
    createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate",
      requestJson: JSON.stringify({ brief: "a bakery" }), now: NOW,
    });
    const worker = new JobWorker({
      db, pool: fakePool(), masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT,
      pollIntervalMs: 5, shutdownWaitMs: 40, shutdownKillGraceMs: 40, now: () => NOW,
      orchestratorSpawnFn,
    });
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-key");

    worker.start();
    await waitUntil(() => spawned);

    const startedAt = Date.now();
    await worker.stop();
    const elapsed = Date.now() - startedAt;

    // The bound itself. Generous headroom over 40+40 so this is not a timing
    // flake, but nowhere near the ~400s a real generate takes — which is the
    // only thing it needs to discriminate.
    expect(elapsed).toBeLessThan(5_000);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills the child, and the run's own ingest + finishJob then land inside the grace window", async () => {
    const genProject = createProject(db, user.id, "run-gen", "Run Gen");
    // A well-behaved child: SIGTERM makes it exit, which is what lets
    // runGenerateJob reach its own ingestUsageLog + finishJob rather than
    // leaving the spend for the next boot's sweeper to delete unread.
    const kill = vi.fn((signal?: NodeJS.Signals) => { if (signal === "SIGTERM") child.emit("exit", null); return true; });
    const child: FakeChild = fakeChildWith(kill);
    let spawned = false;
    const orchestratorSpawnFn = vi.fn(() => { spawned = true; return child; });
    const job = createJob(db, {
      userId: user.id, projectId: genProject.id, kind: "generate",
      requestJson: JSON.stringify({ brief: "a bakery" }), now: NOW,
    });
    const worker = new JobWorker({
      db, pool: fakePool(), masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT,
      pollIntervalMs: 5, shutdownWaitMs: 40, shutdownKillGraceMs: 2_000, now: () => NOW,
      orchestratorSpawnFn,
    });
    setApiKey(db, MASTER_KEY, user.id, "sk-ant-key");

    worker.start();
    await waitUntil(() => spawned);
    await worker.stop();

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).not.toHaveBeenCalledWith("SIGKILL");
    // Reached a terminal state under its OWN code path, which is the same
    // code path that ingests the usage log — not left `running` for
    // markRunningJobsInterrupted to clean up at the next boot.
    expect(findJobById(db, job.id)?.status).toBe("failed");
  });

  it("does not wait out a proxied job's own 15-minute ceiling", async () => {
    // An upstream that accepts the connection and never answers — exactly
    // what `PREVIEW_PROXY_TIMEOUT_MS` exists for, and what stop() used to sit
    // behind for the full 15 minutes.
    const upstream = await startUpstream(() => { /* never responds */ });
    const pool = fakePool({
      acquire: vi.fn(async (): Promise<PreviewProcess> => ({
        projectId: project.id, port: upstream.port, base: "/", inFlight: 0, lastUsedAt: Date.now(),
      })),
    });
    const job = createJob(db, { userId: user.id, projectId: project.id, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({
      db, pool, masterKey: MASTER_KEY, projectsRoot: PROJECTS_ROOT,
      pollIntervalMs: 5, shutdownWaitMs: 40, shutdownKillGraceMs: 40, now: () => NOW,
    });

    try {
      worker.start();
      await waitUntil(() => (pool.acquire as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      const startedAt = Date.now();
      await worker.stop();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // Still running: nothing here kills a preview child (the pool owns
      // those, and serve.ts shuts it down immediately after), and the row
      // becomes `interrupted` on the next boot. What changed is only that
      // shutdown stopped blocking on it.
      expect(findJobById(db, job.id)?.status).toBe("running");
    } finally {
      await upstream.close();
    }
  });
});
