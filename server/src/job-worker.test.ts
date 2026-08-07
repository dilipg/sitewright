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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { usageLogPathFor, USAGE_ID_HEADER } from "../../compiler/src/usage-log-path.ts";
import { setApiKey } from "./api-keys.ts";
import { openDatabase } from "./db.ts";
import { JobWorker } from "./job-worker.ts";
import { claimNextJob, createJob, findJobById } from "./jobs.ts";
import { MASTER_KEY_ENV_VAR } from "./master-key.ts";
import { createProject, type Project } from "./projects.ts";
import { MAX_BILLABLE_IN_FLIGHT_PER_USER, PreviewPool, type PreviewProcess } from "./preview-pool.ts";
import { createUser, type User } from "./users.ts";

const MASTER_KEY = Buffer.alloc(32, 9);
const NOW = 1_800_000_000_000;

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

/** Just enough of PreviewPool's surface for job-worker.ts to call — same idiom preview-forward.test.ts's own fakePool uses, extended with the two billable-slot methods this module also calls directly. */
function fakePool(overrides: Record<string, unknown> = {}): PreviewPool & {
  acquire: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  reserveBillableSlot: ReturnType<typeof vi.fn>;
  releaseBillableSlot: ReturnType<typeof vi.fn>;
} {
  return {
    acquire: vi.fn(async (): Promise<PreviewProcess> => ({
      projectId: project.id, port: 0, base: "/", inFlight: 0, lastUsedAt: Date.now(),
    })),
    retain: vi.fn(),
    release: vi.fn(),
    reserveBillableSlot: vi.fn(() => true),
    releaseBillableSlot: vi.fn(),
    ...overrides,
  } as unknown as PreviewPool & {
    acquire: ReturnType<typeof vi.fn>;
    retain: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    reserveBillableSlot: ReturnType<typeof vi.fn>;
    releaseBillableSlot: ReturnType<typeof vi.fn>;
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

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });
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

    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });
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
      expect(pool.releaseBillableSlot).toHaveBeenCalledWith(user.id);
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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });

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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });

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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });

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

describe("JobWorker: per-user bound", () => {
  it("leaves a third job queued when the user already has two active", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "job-worker-pool-"));
    const pool = new PreviewPool({ db, masterKey: MASTER_KEY, projectsRoot });
    // Simulate two already-active jobs for this user without ever touching
    // the DB — reserveBillableSlot is exactly the in-memory counter
    // job-worker.ts itself calls, so this reproduces the real bound.
    expect(pool.reserveBillableSlot(user.id)).toBe(true);
    expect(pool.reserveBillableSlot(user.id)).toBe(true);

    const job3 = createJob(db, { userId: user.id, projectId: null, kind: "regen", requestJson: "{}", now: NOW });
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });

    const ran = await worker.runOnce();
    expect(ran).toBe(false);
    expect(findJobById(db, job3.id)?.status).toBe("queued");

    // Perturbation-proof: freeing a slot lets the SAME job proceed on the
    // next claim (it will fail for a different, unrelated reason —
    // projectId is null — which itself proves it actually ran this time
    // rather than being blocked again).
    pool.releaseBillableSlot(user.id);
    const ranAgain = await worker.runOnce();
    expect(ranAgain).toBe(true);
    expect(findJobById(db, job3.id)?.status).toBe("failed");

    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("MAX_BILLABLE_IN_FLIGHT_PER_USER is 2 — the bound this test exercises", () => {
    expect(MAX_BILLABLE_IN_FLIGHT_PER_USER).toBe(2);
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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, pollIntervalMs: 5, now: () => NOW });

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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, pollIntervalMs: 5, now: () => NOW });
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
      db, pool, masterKey: MASTER_KEY, now: () => NOW,
      orchestratorDir: "/fake/orchestrator/dir",
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
      db, pool, masterKey: MASTER_KEY, now: () => NOW,
      orchestratorDir: "/fake/orchestrator/dir",
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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });

    const ran = await worker.runOnce();
    expect(ran).toBe(true);
    const finished = findJobById(db, job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("a brief is required");
  });
});

describe("JobWorker: nothing queued", () => {
  it("runOnce() returns false and does nothing when the queue is empty", async () => {
    const pool = fakePool();
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW });
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
    const worker = new JobWorker({ db, pool, masterKey: MASTER_KEY, now: () => NOW + 2 });
    const ran = await worker.runOnce();
    expect(ran).toBe(false);
    expect(findJobById(db, job.id)?.status).toBe("running"); // untouched by this worker
    expect(pool.acquire).not.toHaveBeenCalled();
  });
});
