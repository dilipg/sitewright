// server/src/job-worker.ts
/**
 * Works jobs off the `job` table (server/src/jobs.ts), one at a time.
 *
 * A job is a server-side wrapper around work the server already performs
 * (spec, docs/superpowers/specs/2026-08-06-job-model-design.md). This module
 * does not invent a new execution path for that work — it relocates the
 * already-reviewed one out of an HTTP request handler and into a loop that
 * outlives any single request.
 *
 * TWO EXECUTION STRATEGIES BEHIND ONE TABLE — stated here rather than left
 * implied, because they are genuinely not uniform:
 *
 *   - The five PROXIED kinds (`regen`, `regen-page`, `add-section`,
 *     `edit-prompt`, `export`) already exist as synchronous handlers inside a
 *     project's own preview child (compiler/src/regen-api.ts,
 *     export-api.ts), reached today via `preview-forward.ts`'s
 *     `forwardToPreview`: `pool.acquire` -> `retain` -> a fresh usage id ->
 *     `proxyHttp` the request body -> in ONE `finally`: `release`, then
 *     ingest the usage log ONLY if the exchange actually completed. That
 *     sequence survived three hard reviews and a whole-branch audit (see
 *     preview-forward.ts's own module comment for the full account of why
 *     "completed" is not the same thing as "settled"). This module calls
 *     `forwardToPreview` ITSELF for these five kinds — not a re-derived copy
 *     of its logic — so every one of those reviewed properties (release
 *     waits for genuine completion, ingest is exactly-once, a client-shaped
 *     error never carries a stack trace) carries over unchanged. The only
 *     new code here is the plumbing needed because a job has no live
 *     browser connection to hand `forwardToPreview` a real
 *     `(req, res)` pair — see `exchangeOverLoopback` below.
 *
 *   - `generate` is NOT a wrapper around an existing proxied request, and
 *     cannot be: there is no project preview child to proxy to, because the
 *     site does not exist until generation has run. This module spawns the
 *     orchestrator's own `orchestrator.acceptance` entry point directly,
 *     using the same STYLE the preview pool uses for its own children
 *     (`buildAgentEnv` for a per-user, master-key-free environment; piped,
 *     non-shell stdio; an injectable spawn function for tests) but a
 *     different, cwd-based invocation (`uv run python -m
 *     orchestrator.acceptance`), because that entry point needs a working
 *     directory the pool's own `SpawnFn` has no option for. `WEBGEN_USAGE_LOG`
 *     is pointed at the job's own usage path directly (there is no
 *     `x-webgen-usage-id` HEADER to translate, because there is no HTTP
 *     request to the child at all), and stdout/stderr both go through
 *     `redactSecrets` before anything is logged or stored — the orchestrator
 *     is untrusted output for exactly the reason preview-pool.ts's own
 *     children are (see redact.ts's module comment).
 *
 * BOUNDS, enforced at claim time (not at enqueue — that is a later task's
 * concern for the spend cap specifically; this module only ever runs after a
 * job already exists):
 *
 *   - At most `MAX_BILLABLE_IN_FLIGHT_PER_USER` (today's value: 2) jobs
 *     running at once for one user. Reused, not re-derived: this worker
 *     calls the SAME `PreviewPool.reserveBillableSlot` /
 *     `releaseBillableSlot` pair `compiler-routes.ts`'s `requireBillableSlot`
 *     already uses for the same purpose against live requests — "today's
 *     in-flight reservation, same value, same meaning" is not a coincidence,
 *     it is the same counter. Applied uniformly to all six kinds (including
 *     `export`, which spends nothing, and `generate`, which is the most
 *     expensive of all of them): the bound is about how much CONCURRENT work
 *     one user may have the server doing on their behalf, not narrowly about
 *     billing.
 *   - The preview pool's own cap of `MAX_PREVIEWS` (6) globally, shared with
 *     every OTHER project's live preview traffic. Nothing new needed here
 *     either: `pool.acquire()` already refuses over that cap
 *     (`PreviewCapacityError`), `forwardToPreview` already maps that to a
 *     503, and this module reads that 503 back off the loopback exchange
 *     (see `runProxiedJob`). `generate` does not touch the pool at all
 *     (it has no project preview child to acquire), so this specific bound
 *     does not apply to it — the asymmetry is real, not an oversight.
 *
 * In both cases, "cannot run yet" is NOT a failure: the job is put back to
 * `queued` (never `failed`) so a later claim can try again — "better than
 * today's 503" per the brief. `finishJob`'s own shape stamps `finished_at`
 * unconditionally, which is slightly wrong for a job going BACK to `queued`
 * (it hasn't finished) — `jobs.ts` has no dedicated "requeue" primitive and
 * this task's own file list does not include modifying it, so `requeue()`
 * below accepts that wart rather than reaching past the given interface.
 * Flagged, not hidden: see this file's own `requeue` doc comment.
 *
 * `countActiveJobsForUser` (queued + running) is DELIBERATELY not used for
 * this bound, even though it is one of task 1's listed interfaces: it counts
 * a user's whole pipeline, not their concurrently RUNNING work, so gating a
 * claim on it would block a user's very FIRST job the moment they have two
 * or more OTHERS merely sitting in the queue behind it — a real deadlock,
 * not a false alarm (worked through by hand while designing this module; see
 * the task report for the exact scenario). Its own doc comment says it is
 * for "the spend cap's in-flight reservation" — that is an ENQUEUE-time
 * concern for whichever endpoint creates jobs, not a claim-time concern for
 * this worker.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { USAGE_ID_HEADER, usageLogPathFor } from "../../compiler/src/usage-log-path.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { ingestUsageLog } from "./ingest-usage.ts";
import { claimNextJob, finishJob, type Job, type JobKind } from "./jobs.ts";
import { findProjectById } from "./projects.ts";
import { forwardToPreview } from "./preview-forward.ts";
import { type PreviewPool } from "./preview-pool.ts";
import { redactSecrets } from "./redact.ts";
import { findUserById } from "./users.ts";

/** Every `JobKind` except `generate` — the five that proxy to a project's own preview child. */
type ProxiedJobKind = Exclude<JobKind, "generate">;

/** The literal compiler endpoint each proxied kind replays against, inside the child. */
const PROXIED_PATH: Record<ProxiedJobKind, string> = {
  regen: "/__regen",
  "regen-page": "/__regen-page",
  "add-section": "/__add-section",
  "edit-prompt": "/__edit-prompt",
  export: "/__export",
};

function isProxiedKind(kind: JobKind): kind is ProxiedJobKind {
  return kind !== "generate";
}

/** Never `.stack` — see this module's own binding constraint on what may reach `job.error`. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort extraction of the `{error: string}` shape every failure
 * response in this codebase uses (`sendJson`/`respondJson`, both compiler-
 * and server-side). Falls back to a generic, status-only message for
 * anything else, rather than ever surfacing a raw, unparsed response body
 * (which — for a truly unexpected failure — could in principle be an HTML
 * error page or other content this module did not choose and cannot vouch
 * for).
 */
function extractErrorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed !== null
      && typeof parsed === "object"
      && typeof (parsed as Record<string, unknown>).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON -- fall through to the generic message below.
  }
  return `preview exchange failed with status ${String(status)}`;
}

/**
 * The one piece of genuinely NEW plumbing this module needed: `proxyHttp`
 * (via `forwardToPreview`) takes a real `node:http` `(req, res)` pair, and a
 * job has no live browser connection to supply one — the request body it
 * must replay is a JSON string sitting in a database row, not bytes still
 * arriving on a socket. Node offers no supported way to fabricate a real
 * `IncomingMessage`/`ServerResponse` pair without an actual request/response
 * cycle (the reason libraries like supertest exist, and "no new runtime
 * dependencies" rules one out here) — so this opens a throwaway loopback
 * listener, drives ONE request against it with the recorded body, and hands
 * `handler` the resulting real `(req, res)`. The listener is closed the
 * moment that one exchange ends; nothing here is held open past it.
 */
function exchangeOverLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  path: string,
  requestBody: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOnce = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        // `forwardToPreview` does not throw in practice (proxyHttp never
        // rejects, and this module's own `after` hook never throws either —
        // see below) — this is defence in depth against a future change to
        // either, never a documented path.
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "job-worker: handler failed" }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    server.on("error", (err) => settleOnce(() => reject(err)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const bodyBuf = Buffer.from(requestBody, "utf8");
      const clientReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(bodyBuf.length) },
        },
        (clientRes) => {
          const chunks: Buffer[] = [];
          clientRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          clientRes.on("end", () => {
            settleOnce(() => {
              resolve({ status: clientRes.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
            server.close();
          });
          clientRes.on("error", (err) => {
            settleOnce(() => reject(err));
            server.close();
          });
        },
      );
      clientReq.on("error", (err) => {
        settleOnce(() => reject(err));
        server.close();
      });
      clientReq.end(bodyBuf);
    });
  });
}

/**
 * The minimal shape `generate`'s orchestrator spawn needs from a child —
 * deliberately narrower than `node:child_process`'s own `ChildProcess`,
 * mirroring `preview-pool.ts`'s own `SpawnedChild` (same reasoning: a test
 * double need not implement the dozens of members this module will never
 * touch). NOT the same type as `preview-pool.ts`'s `SpawnFn`: that one has
 * no `cwd` option, because the preview child resolves its own project
 * directory from a CLI argument, not from its working directory — but `uv
 * run` needs to be invoked FROM `orchestrator/` to find its `pyproject.toml`
 * (the same convention `compiler/src/regen-api.ts`'s `runProcess` already
 * uses for every other orchestrator CLI spawn in this codebase), so this
 * type carries one.
 */
interface OrchestratorSpawnedChild {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

type OrchestratorSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => OrchestratorSpawnedChild;

const defaultOrchestratorSpawnFn: OrchestratorSpawnFn = (command, args, options) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  return child as unknown as OrchestratorSpawnedChild;
};

// Resolved from this file's own URL, never a hardcoded absolute path — same
// technique preview-pool.ts uses for DEFAULT_PREVIEW_SCRIPT, for the same
// reason (the repo can be checked out anywhere).
const DEFAULT_ORCHESTRATOR_DIR = fileURLToPath(new URL("../../orchestrator", import.meta.url));

/** How often `start()`'s interval attempts a claim when the queue was empty (or blocked) last time. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** A generic Error's `.message` only — see `messageOf`. */
type JobOutcome =
  | { readonly kind: "succeeded"; readonly resultJson: string }
  | { readonly kind: "failed"; readonly error: string }
  /** Not this job's fault, and not permanent — see this module's own bounds comment. */
  | { readonly kind: "requeue" };

export interface JobWorkerDeps {
  db: DatabaseSync;
  pool: PreviewPool;
  masterKey: Buffer;
  /** cwd for `generate`'s orchestrator spawn. Defaults to the repo's own `orchestrator/` directory. */
  orchestratorDir?: string;
  /** Overridable for tests; production default spawns `uv` for real via `node:child_process`. */
  orchestratorSpawnFn?: OrchestratorSpawnFn;
  /** Defaults to `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  now?: () => number;
}

export class JobWorker {
  private readonly db: DatabaseSync;
  private readonly pool: PreviewPool;
  private readonly masterKey: Buffer;
  private readonly orchestratorDir: string;
  private readonly orchestratorSpawnFn: OrchestratorSpawnFn;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** The currently-dispatched tick's promise, tracked so `stop()` can await it — see `stop()`'s own comment. */
  private inFlight: Promise<void> | undefined;

  constructor(deps: JobWorkerDeps) {
    this.db = deps.db;
    this.pool = deps.pool;
    this.masterKey = deps.masterKey;
    this.orchestratorDir = deps.orchestratorDir ?? DEFAULT_ORCHESTRATOR_DIR;
    this.orchestratorSpawnFn = deps.orchestratorSpawnFn ?? defaultOrchestratorSpawnFn;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Arms an `unref()`'d interval so this worker never holds the process open
   * on its own — `scripts/serve.ts`'s normal shutdown path is `stop()`, but a
   * process that exits for any other reason must not be kept alive by this
   * timer alone. Idempotent: a second call while already started is a no-op,
   * never a second interval.
   *
   * Fires one tick immediately, in addition to arming the interval — a
   * freshly booted server should not sit idle for a full
   * `pollIntervalMs` before its first claim attempt.
   *
   * Ticks never overlap: a tick that is still running when the next one
   * would fire is skipped outright rather than queued or run alongside it —
   * "claim a job, run it, finish it, repeat," not a job pool. A caller that
   * wants genuine concurrency (this module's own tests, to prove the
   * per-user bound) can still call `runOnce()` directly without going
   * through `start()` at all; nothing about `runOnce()` itself is
   * single-flight.
   */
  start(): void {
    if (this.timer !== undefined) return;
    const runTick = async (): Promise<void> => {
      try {
        await this.runOnce();
      } catch (err) {
        // A tick that throws must not take the whole interval down with it
        // — `runOnce()` itself should not throw (every failure path inside
        // it is caught and turned into a `failed` job), but this is the
        // backstop if it ever does.
        console.error(`[job-worker] tick failed: ${redactSecrets(messageOf(err))}`);
      } finally {
        this.inFlight = undefined;
      }
    };
    const tick = (): void => {
      if (this.inFlight !== undefined) return;
      this.inFlight = runTick();
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref();
    tick();
  }

  /**
   * Stops arming new ticks and, unlike simply abandoning the worker, AWAITS
   * whichever tick is currently in flight rather than leaving it to finish
   * (or not) after this promise resolves — a job mid-run at shutdown is
   * exactly the case spec decision 13 says must not be corrupted by being
   * killed partway. Safe to call when nothing is running, or when `start()`
   * was never called at all.
   */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight !== undefined) {
      await this.inFlight;
    }
  }

  /**
   * Claims and fully runs at most one job, or does nothing if the queue is
   * empty or the only claimable job cannot run yet. Returns `true` only when
   * a job reached a terminal state (`succeeded`/`failed`) this call — `false`
   * for both "nothing queued" and "claimed something but had to requeue it,"
   * since a caller polling this in a loop reacts to both the same way: wait
   * and try again.
   */
  async runOnce(): Promise<boolean> {
    const job = claimNextJob(this.db, this.now());
    if (job === null) return false;

    // The per-user concurrency bound — see this module's own comment on why
    // `reserveBillableSlot`/`releaseBillableSlot` (not `countActiveJobsForUser`)
    // is the right mechanism here.
    if (!this.pool.reserveBillableSlot(job.userId)) {
      this.requeue(job);
      return false;
    }

    let outcome: JobOutcome;
    try {
      outcome = isProxiedKind(job.kind)
        ? await this.runProxiedJob(job, job.kind)
        : await this.runGenerateJob(job);
    } finally {
      this.pool.releaseBillableSlot(job.userId);
    }

    if (outcome.kind === "requeue") {
      this.requeue(job);
      return false;
    }
    finishJob(this.db, job.id, {
      status: outcome.kind,
      resultJson: outcome.kind === "succeeded" ? outcome.resultJson : null,
      error: outcome.kind === "failed" ? outcome.error : null,
      now: this.now(),
    });
    return true;
  }

  /**
   * Puts a claimed job back to `queued` rather than failing it — "a job that
   * cannot run yet stays queued, never fail it for being early." `finishJob`
   * is the only status-writing primitive `jobs.ts` exports, and it always
   * stamps `finished_at`, which is not quite right for a job going back to
   * `queued` (it has not finished). Accepted rather than reached past this
   * task's given interface (`jobs.ts` is not in this task's file list) — see
   * this module's own top comment. A later task adding a dedicated
   * `requeueJob(db, id)` that leaves `finished_at` null would close this
   * cleanly.
   */
  private requeue(job: Job): void {
    finishJob(this.db, job.id, { status: "queued", now: this.now() });
  }

  /**
   * The five proxied kinds: `forwardToPreview`, called exactly as
   * `compiler-routes.ts` calls it for a live request, over a synthetic
   * `(req, res)` pair obtained from `exchangeOverLoopback` — see that
   * function's own comment for why a real loopback round trip, not a
   * hand-rolled duck-typed pair, is what stands in for the live browser
   * connection a job does not have.
   */
  private async runProxiedJob(job: Job, kind: ProxiedJobKind): Promise<JobOutcome> {
    if (job.projectId === null) {
      return { kind: "failed", error: "job has no project to run against" };
    }
    const project = findProjectById(this.db, job.projectId);
    if (project === null) {
      return { kind: "failed", error: "project no longer exists" };
    }
    const user = findUserById(this.db, job.userId);
    if (user === null) {
      return { kind: "failed", error: "user no longer exists" };
    }

    const handler = forwardToPreview(this.pool, {
      billable: () => {
        const usageId = randomBytes(16).toString("hex");
        return {
          setHeaders: { [USAGE_ID_HEADER]: usageId },
          after: () => {
            const usagePath = usageLogPathFor(usageId);
            // Never throws, by ingest-usage.ts's own contract -- safe to
            // call unconditionally, including for a run that made no model
            // calls (a legitimate no-op, not an error). Mirrors
            // compiler-routes.ts's own billableForward exactly.
            const result = ingestUsageLog(this.db, {
              path: usagePath, userId: job.userId, projectId: project.id, now: this.now(),
            });
            if (result.skipped > 0 || result.unreadable) {
              console.error(
                `[job-worker] usage log ingest lost spend for job ${job.id} `
                + `(user ${job.userId}, project ${project.id}): ingested=${String(result.ingested)} `
                + `skipped=${String(result.skipped)} unreadable=${String(result.unreadable)} — spend may be unrecorded`,
              );
            }
            try {
              unlinkSync(usagePath);
            } catch {
              // Nothing to delete -- either no model calls happened, or it's
              // already gone. ingest above already ran (or correctly
              // no-opped) either way.
            }
          },
        };
      },
    });

    const path = PROXIED_PATH[kind];
    let exchange: { status: number; body: string };
    try {
      exchange = await exchangeOverLoopback(
        (req, res) => handler(req, res, { url: new URL(path, "http://job-worker.internal"), params: {}, user, project }),
        path,
        job.requestJson,
      );
    } catch (err) {
      return { kind: "failed", error: redactSecrets(messageOf(err)) };
    }

    // 503 is `forwardToPreview`'s own mapping of `PreviewCapacityError` (see
    // its module comment) -- the global pool-of-6 bound, not this job's
    // fault, and not permanent.
    if (exchange.status === 503) {
      return { kind: "requeue" };
    }
    if (exchange.status >= 200 && exchange.status < 300) {
      return { kind: "succeeded", resultJson: exchange.body };
    }
    return { kind: "failed", error: redactSecrets(extractErrorMessage(exchange.body, exchange.status)) };
  }

  /**
   * `generate`: spawns `orchestrator.acceptance` directly. See this module's
   * top comment for why this kind cannot reuse `forwardToPreview` at all.
   */
  private async runGenerateJob(job: Job): Promise<JobOutcome> {
    let requestPayload: unknown;
    try {
      requestPayload = JSON.parse(job.requestJson);
    } catch {
      return { kind: "failed", error: "malformed request payload" };
    }
    const brief = requestPayload !== null && typeof requestPayload === "object"
      ? (requestPayload as Record<string, unknown>).brief
      : undefined;
    if (typeof brief !== "string" || brief.trim() === "") {
      return { kind: "failed", error: "a brief is required" };
    }

    if (job.projectId === null) {
      return { kind: "failed", error: "job has no project to generate into" };
    }
    const project = findProjectById(this.db, job.projectId);
    if (project === null) {
      return { kind: "failed", error: "project no longer exists" };
    }

    let env: NodeJS.ProcessEnv;
    try {
      // No pasted-key support here on purpose: `request_json` must never
      // carry an API key (jobs.ts's own doc comment), so a job can only ever
      // spend the user's STORED key, resolved fresh at run time.
      env = buildAgentEnv({ db: this.db, masterKey: this.masterKey, userId: job.userId });
    } catch (err) {
      return { kind: "failed", error: redactSecrets(messageOf(err)) };
    }

    const usageId = randomBytes(16).toString("hex");
    const usagePath = usageLogPathFor(usageId);
    // Unlike the proxied kinds, there is no `usageEnvFor` translator running
    // inside a child to create this directory on receipt of a header --
    // this module IS the one setting `WEBGEN_USAGE_LOG` directly, so it must
    // also ensure the directory exists.
    mkdirSync(dirname(usagePath), { recursive: true });
    env.WEBGEN_USAGE_LOG = usagePath;

    let spawned: { stdout: string; stderr: string; code: number | null };
    try {
      spawned = await this.runOrchestratorProcess(env, [
        "run", "python", "-m", "orchestrator.acceptance",
        "--brief", brief,
        "--run-id", project.directory,
      ]);
    } catch (err) {
      // The process never started at all (e.g. `uv` missing from PATH) --
      // nothing ran, so there is nothing to ingest, matching the proxied
      // kinds' own "ingest only if the exchange completed" rule.
      return { kind: "failed", error: redactSecrets(messageOf(err)) };
    }

    // The child genuinely ran (started and exited) whether it succeeded or
    // not -- ingest unconditionally, same rule ingest-usage.ts's own
    // docstring states for the proxied kinds ("even when it threw"): a run
    // that fails partway through a multi-stage pipeline can still have spent
    // real money on the stages it got through.
    const ingestResult = ingestUsageLog(this.db, {
      path: usagePath, userId: job.userId, projectId: project.id, now: this.now(),
    });
    if (ingestResult.skipped > 0 || ingestResult.unreadable) {
      console.error(
        `[job-worker] usage log ingest lost spend for generate job ${job.id} `
        + `(user ${job.userId}, project ${project.id}): ingested=${String(ingestResult.ingested)} `
        + `skipped=${String(ingestResult.skipped)} unreadable=${String(ingestResult.unreadable)} — spend may be unrecorded`,
      );
    }
    try {
      unlinkSync(usagePath);
    } catch {
      // Nothing to delete.
    }

    const safeStdout = redactSecrets(spawned.stdout);
    const safeStderr = redactSecrets(spawned.stderr);
    if (spawned.code !== 0) {
      const tail = (safeStderr.trim() !== "" ? safeStderr : safeStdout).slice(-2000);
      return { kind: "failed", error: `orchestrator exited with code ${String(spawned.code)}: ${tail}` };
    }
    return { kind: "succeeded", resultJson: JSON.stringify({ stdout: safeStdout.slice(-4000) }) };
  }

  private runOrchestratorProcess(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = this.orchestratorSpawnFn("uv", args, { cwd: this.orchestratorDir, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (err: Error) => reject(err));
      child.on("exit", (code: number | null) => resolve({ stdout, stderr, code }));
    });
  }
}
