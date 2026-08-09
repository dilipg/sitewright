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
 *     `(req, res)` pair — see `exchangeOverLoopback` below. One check that
 *     used to be purely an enqueue-time concern is re-run HERE, at claim
 *     time, for a billable kind: the user's API key must still be usable when
 *     the work actually starts, not merely when it was queued (see
 *     `runProxiedJob`).
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
 *     children are (see redact.ts's module comment). `orchestrator.acceptance`
 *     takes only a `--run-id` and writes into its OWN hardcoded
 *     `GENERATED_DIR`, so where the site lands is not something this module
 *     gets to choose — `assertProjectsRootMatchesOrchestrator` (below) is how
 *     the disagreement is made impossible to have silently.
 *
 * BOUNDS, enforced at claim time (not at enqueue — that is a later task's
 * concern for the spend cap specifically; this module only ever runs after a
 * job already exists). REVISED from this task's first pass: the per-user
 * bound now lives INSIDE `jobs.ts`'s `claimNextJob` itself, not here — see
 * that function's own comment for the full account of why (in short: a
 * chronically-blocked user's oldest job was being claimed and immediately
 * requeued on every single tick, and since a requeue does not change
 * `created_at`, that same job was always the next one claimed too — starving
 * every OTHER user's queued work behind it, forever, in FIFO order. Pushing
 * the bound into the claim's own SQL selection means a blocked user's job is
 * simply never selected in the first place, so eligible jobs — including
 * every other user's — remain reachable the whole time).
 *
 *   - At most `MAX_ACTIVE_JOBS_PER_USER` (today's value: 2, defined in and
 *     owned by `jobs.ts`, pinned equal to `preview-pool.ts`'s
 *     `MAX_BILLABLE_IN_FLIGHT_PER_USER` by a test in jobs.test.ts — "today's
 *     in-flight reservation, same value, same meaning") jobs `running` at once for one
 *     user. Enforced by `claimNextJob`'s own query: a user already at the
 *     limit simply has none of their `queued` jobs selected, atomically, in
 *     the same statement that claims someone else's. This worker does not
 *     call `PreviewPool.reserveBillableSlot`/`releaseBillableSlot` at all —
 *     an earlier version of this file did, as a claim-time gate that
 *     requeued a blocked job after already claiming it, which is exactly the
 *     starvation bug above. Applied uniformly to all six kinds via the same
 *     `job.user_id` column (including `export`, which spends nothing, and
 *     `generate`, which is the most expensive of all of them): the bound is
 *     about how much CONCURRENT work one user may have the server doing on
 *     their behalf, not narrowly about billing.
 *   - The preview pool's own cap of `MAX_PREVIEWS` (6) globally, shared with
 *     every OTHER project's live preview traffic. This ONE bound
 *     `claimNextJob` cannot see in advance (it has no visibility into the
 *     in-memory pool at all) — `pool.acquire()` already refuses over that
 *     cap (`PreviewCapacityError`), `forwardToPreview` already maps that to
 *     a 503, and this module reads that 503 back off the loopback exchange
 *     (see `runProxiedJob`) and calls `jobs.ts`'s `requeueJob` — the ONE
 *     remaining requeue-after-claim path, and the reason `requeueJob` exists
 *     rather than being fully subsumed by the claim-time fix above.
 *     `generate` does not touch the pool at all (it has no project preview
 *     child to acquire), so this specific bound does not apply to it — the
 *     asymmetry is real, not an oversight.
 *
 * In both cases, "cannot run yet" is NOT a failure: the job is put back to
 * `queued` (never `failed`) so a later claim can try again — "better than
 * today's 503" per the brief. Unlike this task's first pass, this no longer
 * risks stamping `finished_at` on a requeued job: `jobs.ts`'s `requeueJob`
 * clears `started_at` and never touches `finished_at`, and `finishJob`'s own
 * `status` parameter is now typed `TerminalJobStatus` — `queued`/`running`
 * are not assignable to it at all, so passing either to `finishJob` is a
 * compile error, not merely a discouraged call.
 *
 * `countActiveJobsForUser` (queued + running) is DELIBERATELY not used for
 * either bound, even though it is one of task 1's listed interfaces: it
 * counts a user's whole pipeline, not their concurrently RUNNING work, so
 * gating a claim on it would block a user's very FIRST job the moment they
 * have two or more OTHERS merely sitting in the queue behind it — a real
 * deadlock, not a false alarm (worked through by hand while designing this
 * module; see the task report for the exact scenario). Its own doc comment
 * says it is for "the spend cap's in-flight reservation" — that is an
 * ENQUEUE-time concern for whichever endpoint creates jobs, not a claim-time
 * concern for this worker. `claimNextJob`'s own subquery counts `running`
 * only, for the identical reason.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { USAGE_ID_HEADER, usageLogPathFor } from "../../compiler/src/usage-log-path.ts";
import { buildAgentEnv, DisabledUserError, MissingApiKeyError, UnknownUserError } from "./agent-env.ts";
import { UndecryptableApiKeyError } from "./api-keys.ts";
import { codeVersionsIncompatible, resolveCodeVersion } from "./code-version.ts";
import { ingestUsageLog } from "./ingest-usage.ts";
import {
  BILLABLE_JOB_KINDS, claimNextJob, finishJob, findJobById, isSafeRunId, recordJobRun, requeueJob,
  type Job, type JobKind,
} from "./jobs.ts";
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
 *
 * WHOLE-BRANCH REVIEW, FINDING A — the listener is NOT open to whoever
 * reaches it. `handler` is `forwardToPreview` closed over a FIXED, already
 * authorized `{user, project}` ctx, and it forwards `req.url` verbatim into
 * that tenant's Vite child. A bare `server.listen(0, "127.0.0.1")` therefore
 * hands ANY other local process that connects during a 27s-to-15-minute job
 * an authenticated, authorized channel into that tenant: `PUT
 * /__overrides/...`, `/@fs/...` reads, or another billable `/__regen` on that
 * user's account. Ephemeral, but discoverable by `ss -ltn` or by brute force
 * over a minutes-long window — and "an ephemeral port nobody guesses" is not
 * an authorization decision.
 *
 * So every request must carry a per-exchange 128-bit token in
 * `LOOPBACK_TOKEN_HEADER`, generated here and known only to the one client
 * request this function itself drives. Anything else gets a 404 (not a 401 or
 * 403: a foreign connection learns nothing at all about what is listening,
 * which is also the answer `require-project.ts` already gives a foreign
 * project id). The header is compared in constant time and then DELETED
 * before `handler` runs, so it is never forwarded on to the child.
 */
export const LOOPBACK_TOKEN_HEADER = "x-webgen-loopback-token";

/** Constant-time on the equal-length path; a length mismatch is already a miss. */
function tokenMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function exchangeOverLoopback(
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

    // Fresh per exchange, never derived from the job or the user: the token
    // exists only to prove "this is the request this function itself sent",
    // so it must not be predictable from anything an attacker could know.
    const token = randomBytes(16).toString("hex");

    const server = createServer((req, res) => {
      if (!tokenMatches(req.headers[LOOPBACK_TOKEN_HEADER], token)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      // Never forwarded to the child — the child has no use for it, and the
      // rule this module follows everywhere else is that nothing internal
      // leaks outward into a process running unvalidated code.
      delete req.headers[LOOPBACK_TOKEN_HEADER];
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
          headers: {
            "content-type": "application/json",
            "content-length": String(bodyBuf.length),
            [LOOPBACK_TOKEN_HEADER]: token,
          },
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
  /**
   * Whole-branch review, FINDING C: shutdown has to be able to terminate this
   * child. Without it the orchestrator survives the server that started it,
   * keeps spending, and keeps appending to a usage log the next boot's
   * `sweepStaleUsageLogs` unlinks unread. Optional so an existing test double
   * that never needed one still satisfies the type; `stop()` treats an absent
   * `kill` as "nothing I can do" and says so in its log line.
   */
  kill?(signal?: NodeJS.Signals): boolean;
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

/**
 * The directory `orchestrator.acceptance` ACTUALLY writes a generated site
 * into, derived here exactly the way the orchestrator derives it for itself:
 * `orchestrator/src/orchestrator/section_pipeline.py`'s
 * `GENERATED_DIR = REPO_ROOT / "generated"`, where `config.py` defines
 * `REPO_ROOT = ORCHESTRATOR_ROOT.parent` and `ORCHESTRATOR_ROOT` is the
 * `orchestrator/` package root. So: the sibling `generated/` of whatever
 * `orchestrator/` directory this worker spawns `uv` in.
 *
 * This is a DERIVATION of a value this package does not own, which is exactly
 * why it is pinned by a test that reads the Python source
 * (job-worker.test.ts, "orchestrator output directory") — the same
 * "two languages, one contract, one machine-checked pin" shape
 * `fixtures/usage-log-contract.jsonl` already uses for the usage log.
 */
export function orchestratorGeneratedDir(orchestratorDir: string): string {
  return resolve(orchestratorDir, "..", "generated");
}

/**
 * WHOLE-BRANCH REVIEW, CRITICAL 1 — "a generation writes its site where
 * nothing looks for it."
 *
 * `scripts/serve.ts` takes `--projects-root`, defaulting to `../generated`
 * relative to CWD, and everything on the SERVER side resolves a project's
 * directory under it: `job-routes.ts`'s `POST /api/generate` creates
 * `<projectsRoot>/web-<uuid>`, `PreviewPool.installEntry` spawns Vite in it,
 * `adopt.ts` scans it. But `orchestrator.acceptance` takes only `--run-id`
 * and writes into its OWN `GENERATED_DIR`, an absolute path derived from the
 * orchestrator package's location, with no output-directory argument and no
 * environment override. If the two disagree, a generation still runs, still
 * spends real money, and still finishes `succeeded` — into a directory
 * nothing on the server side will ever look at, leaving the user billed for a
 * site that cannot be previewed, exported, or edited.
 *
 * Nothing could OBSERVE that disagreement before this: `JobWorkerDeps` did not
 * carry `projectsRoot` at all. It does now, and this refuses to construct the
 * worker — and so refuses to boot the server — when the two do not name the
 * same directory.
 *
 * WHY THIS SHAPE AND NOT AN `--out-dir` ON THE PYTHON SIDE (the other option
 * the review offered, and the one that is "correct in general"): `GENERATED_DIR`
 * is a module-level constant imported and re-derived by twenty orchestrator
 * modules — the plan pipeline, the design pipeline, the shell pipeline,
 * fan-out, the page worker, regeneration, add-section, the edit agent, soak,
 * stress, and both acceptance entry points. Threading a real output directory
 * through all of them is a cross-cutting change to the entire Python package
 * whose only honest end-to-end verification is a live generation run — which
 * this round may not perform (no real API calls). A loud, boot-time refusal
 * makes the disagreement structurally impossible to have SILENTLY, which is
 * the actual failure being fixed, at a small fraction of that risk. The
 * general fix stays available; it is recorded as the follow-up, not smuggled
 * in here.
 *
 * The message names BOTH resolved absolute paths, because the whole class of
 * mistake this catches is an operator not realising which directory a
 * relative `--projects-root` resolved against.
 */
export function assertProjectsRootMatchesOrchestrator(
  projectsRoot: string,
  orchestratorDir: string,
): void {
  const resolvedProjectsRoot = resolve(projectsRoot);
  const generatedDir = orchestratorGeneratedDir(orchestratorDir);
  // `relative(a, b) === ""` rather than a string `===`: on win32 the two
  // sides can legitimately differ in drive-letter case (one comes from
  // `process.cwd()`, the other from a `file:` URL), and `path.relative`
  // already applies the platform's own comparison rules.
  if (relative(resolvedProjectsRoot, generatedDir) !== "") {
    throw new Error(
      "job worker refused to start: --projects-root and the orchestrator's own output directory disagree, "
      + `so a generation would write its site where nothing looks for it. projects root: ${resolvedProjectsRoot}; `
      + `orchestrator writes into: ${generatedDir}. `
      + "orchestrator.acceptance has no output-directory argument, so these must name the same directory.",
    );
  }
}

/** How often `start()`'s interval attempts a claim when the queue was empty (or blocked) last time. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * WHOLE-BRANCH REVIEW, FINDING C — how long `stop()` waits for the in-flight
 * tick to finish ON ITS OWN before it starts terminating things.
 *
 * `stop()` used to await that tick with no bound at all: up to ~400s for a
 * generate, or the full 15 minutes of `PREVIEW_PROXY_TIMEOUT_MS` for a
 * proxied kind. Under any supervisor, SIGKILL lands long before that — so the
 * "await" bought nothing and the orchestrator child (never tracked, never
 * killed) simply survived, kept spending, and kept appending to a usage log
 * that the NEXT boot's `sweepStaleUsageLogs` unlinks unread. A deploy during a
 * generation destroyed the record of ~$1-2 of real spend.
 *
 * Bounded, the sequence becomes: wait this long, then kill the orchestrator
 * child, then give the tick `SHUTDOWN_KILL_GRACE_MS` more to notice the exit
 * and run its OWN ingest + `finishJob`. That second window is the point —
 * killing the child makes `runOrchestratorProcess` resolve, which puts the
 * spend into `usage_event` instead of leaving it for the sweeper. Total bound:
 * the two added together, chosen to sit comfortably inside a typical 10-30s
 * supervisor grace period.
 */
const SHUTDOWN_WAIT_MS = 5_000;

/** How long `stop()` waits AFTER killing the orchestrator child, so the tick can ingest its spend and finish the job. */
const SHUTDOWN_KILL_GRACE_MS = 2_000;

/** Resolves `undefined` if `promise` has not settled within `ms` — mirrors preview-pool.ts's own `raceReadyPromise`. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    // unref()'d: a shutdown timer must never itself be the reason the process
    // stays alive, the same rule serve.ts's reaper interval follows.
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

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
  /**
   * The SAME projects root `scripts/serve.ts` hands `PreviewPool` and
   * `adoptExistingProjects` — where a project's `directory` is resolved
   * against. REQUIRED, not optional with a safe default: making it a
   * compile error to omit is what forces the composition root to state it,
   * and stating it is what lets the constructor check it against the
   * orchestrator's own hardcoded output directory. See
   * `assertProjectsRootMatchesOrchestrator`.
   */
  projectsRoot: string;
  /** cwd for `generate`'s orchestrator spawn. Defaults to the repo's own `orchestrator/` directory. */
  orchestratorDir?: string;
  /** Overridable for tests; production default spawns `uv` for real via `node:child_process`. */
  orchestratorSpawnFn?: OrchestratorSpawnFn;
  /** Defaults to `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /** Defaults to `SHUTDOWN_WAIT_MS`. Overridable so a test can prove the bound exists without waiting 5s for it. */
  shutdownWaitMs?: number;
  /** Defaults to `SHUTDOWN_KILL_GRACE_MS`. Same reason. */
  shutdownKillGraceMs?: number;
  now?: () => number;
  /**
   * Task 7 (resume): stamped onto every job this worker actually runs (see
   * `recordJobRun`), so `job-routes.ts`'s resume endpoint can refuse to
   * resume across a deploy that edited a checkpoint's body. Defaults to
   * `resolveCodeVersion()` — real production code (scripts/serve.ts) always
   * passes its OWN single boot-time value explicitly instead, so this
   * worker's stamp and the resume endpoint's comparison read the identical
   * string; the default here exists only so the ~20 pre-task-7 tests in
   * job-worker.test.ts that do not care about resume need not each supply
   * one.
   */
  codeVersion?: string;
}

export class JobWorker {
  private readonly db: DatabaseSync;
  private readonly pool: PreviewPool;
  private readonly masterKey: Buffer;
  private readonly orchestratorDir: string;
  private readonly orchestratorSpawnFn: OrchestratorSpawnFn;
  private readonly pollIntervalMs: number;
  private readonly shutdownWaitMs: number;
  private readonly shutdownKillGraceMs: number;
  private readonly now: () => number;
  private readonly codeVersion: string;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** The currently-dispatched tick's promise, tracked so `stop()` can await it — see `stop()`'s own comment. */
  private inFlight: Promise<void> | undefined;
  /**
   * The orchestrator subprocess a `generate` job currently has running, if
   * any — whole-branch review, FINDING C. Tracked for exactly one reason:
   * `stop()` must be able to terminate it. An untracked child outlives the
   * server, keeps spending the user's key, and keeps appending to a usage log
   * the next boot's `sweepStaleUsageLogs` deletes unread. Set for the whole
   * life of `runOrchestratorProcess` and cleared in the same `finally` that
   * settles it, so it never names a process that has already exited.
   */
  private activeOrchestratorRun:
    | { child: OrchestratorSpawnedChild; jobId: string; usagePath: string }
    | undefined;

  constructor(deps: JobWorkerDeps) {
    this.db = deps.db;
    this.pool = deps.pool;
    this.masterKey = deps.masterKey;
    this.orchestratorDir = deps.orchestratorDir ?? DEFAULT_ORCHESTRATOR_DIR;
    // BEFORE anything else this constructor does: a worker whose projects
    // root disagrees with where the orchestrator actually writes must never
    // exist at all, let alone be startable. See
    // `assertProjectsRootMatchesOrchestrator` for the full account.
    assertProjectsRootMatchesOrchestrator(deps.projectsRoot, this.orchestratorDir);
    this.orchestratorSpawnFn = deps.orchestratorSpawnFn ?? defaultOrchestratorSpawnFn;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.shutdownWaitMs = deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS;
    this.shutdownKillGraceMs = deps.shutdownKillGraceMs ?? SHUTDOWN_KILL_GRACE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.codeVersion = deps.codeVersion ?? resolveCodeVersion();
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
   * Stops arming new ticks and, unlike simply abandoning the worker, awaits
   * whichever tick is currently in flight rather than leaving it to finish
   * (or not) after this promise resolves — a job mid-run at shutdown is
   * exactly the case spec decision 13 says must not be corrupted by being
   * killed partway. Safe to call when nothing is running, or when `start()`
   * was never called at all. Idempotent in the sense that matters: a second
   * call with nothing in flight is a no-op.
   *
   * WHOLE-BRANCH REVIEW, FINDING C — that await is now BOUNDED, and the
   * orchestrator child is killed rather than orphaned.
   *
   * The unbounded version was worse than useless. It could wait ~400s for a
   * generate (or the full 15 minutes of `PREVIEW_PROXY_TIMEOUT_MS` for a
   * proxied kind), so under any supervisor SIGKILL landed first; the
   * orchestrator child was never tracked and never killed, so it survived the
   * server, kept spending, and kept appending to its usage log — which the
   * NEXT boot's `sweepStaleUsageLogs` unlinks unread. A deploy during a
   * generation therefore destroyed the record of ~$1-2 of real spend.
   *
   * The bounded sequence recovers most of that instead of merely bounding the
   * damage: wait `shutdownWaitMs` for the tick to finish on its own, then
   * kill the orchestrator child, then wait `shutdownKillGraceMs` more. That
   * second window is the load-bearing part — killing the child makes
   * `runOrchestratorProcess` resolve, so `runGenerateJob` runs its OWN
   * `ingestUsageLog` and `finishJob` and the spend lands in `usage_event`
   * rather than being swept away at next boot.
   *
   * A PROXIED job in flight is deliberately not killed here: its work runs in
   * a preview child that `scripts/serve.ts` kills immediately afterwards via
   * `pool.shutdown()`, and its row becomes `interrupted` on the next boot
   * (`markRunningJobsInterrupted`) — the designed recovery. What changed for
   * it is only that shutdown no longer blocks on it for up to 15 minutes.
   */
  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight === undefined) return;

    if (await raceWithTimeout(this.inFlight.then(() => true), this.shutdownWaitMs) === true) return;

    const run = this.activeOrchestratorRun;
    if (run === undefined) {
      // A proxied job still going. Nothing here owns a process to kill (the
      // preview child belongs to the pool, which serve.ts shuts down next),
      // so this is where shutdown stops waiting.
      console.warn(
        `[job-worker] shutdown: a job is still running after ${String(this.shutdownWaitMs)}ms; `
        + "leaving it — it will be marked interrupted on the next boot",
      );
      return;
    }

    if (typeof run.child.kill !== "function") {
      console.error(
        `[job-worker] shutdown: orchestrator child for job ${run.jobId} cannot be killed (no kill()); `
        + `spend in ${run.usagePath} may go unrecorded`,
      );
      return;
    }
    run.child.kill("SIGTERM");
    if (await raceWithTimeout(this.inFlight.then(() => true), this.shutdownKillGraceMs) === true) return;
    // It did not exit within the grace period, so its spend is NOT ingested
    // and the next boot's sweeper will delete the log unread. Named loudly
    // because that is real money whose record is about to be lost, and this
    // line is the only trace of it an operator will ever get.
    run.child.kill("SIGKILL");
    console.error(
      `[job-worker] shutdown: orchestrator child for job ${run.jobId} did not exit within `
      + `${String(this.shutdownKillGraceMs)}ms of SIGTERM; killed. Spend recorded in ${run.usagePath} `
      + "will be swept unread on the next boot and will NOT be billed",
    );
  }

  /**
   * Claims and fully runs at most one job, or does nothing if the queue is
   * empty or the only claimable job cannot run yet. Returns `true` only when
   * a job reached a terminal state (`succeeded`/`failed`) this call — `false`
   * for both "nothing queued" and "claimed something but had to requeue it,"
   * since a caller polling this in a loop reacts to both the same way: wait
   * and try again.
   *
   * No per-user gate here: `claimNextJob` itself already refuses to hand
   * back a job whose user is at `MAX_ACTIVE_JOBS_PER_USER` — see this
   * module's own top comment and `jobs.ts`'s `claimNextJob` for why that
   * moved out of the worker.
   *
   * Task-7-review finding 3: `job-routes.ts`'s resume endpoint only checks
   * `codeVersionsIncompatible` at ENQUEUE time. A resumed job can then sit
   * `queued` for minutes (the bound is 2 concurrent per user, and a
   * `generate` run measures ~286s) — `markRunningJobsInterrupted` converts
   * only `running` rows on restart, so a `queued` resume survives untouched.
   * If a deploy changing a checkpoint's body lands while it waits, the
   * enqueue-time check already passed and nothing re-runs it: the identical
   * 2026-07-28 failure mode (a stale paired checkpoint silently skipping its
   * side effect) through a different door. This re-checks at the ONE point
   * guaranteed to run immediately before a resumed job's real checkpoints
   * do, for EITHER execution strategy, rather than duplicating the guard
   * inside both `runProxiedJob` and `runGenerateJob`.
   */
  async runOnce(): Promise<boolean> {
    const job = claimNextJob(this.db, this.now());
    if (job === null) return false;

    if (job.resumedFromJobId !== null) {
      const original = findJobById(this.db, job.resumedFromJobId);
      // `original === null` is unreachable via any path that exists today
      // (`resumed_from_job_id` is `ON DELETE SET NULL`, and nothing deletes
      // a job row) — treated as nothing to compare against, not a failure,
      // rather than refusing a job over evidence that does not exist.
      if (original !== null && codeVersionsIncompatible(original.codeVersion, this.codeVersion)) {
        finishJob(this.db, job.id, {
          status: "failed",
          error: "the server code changed since the resumed job last ran; refused before running — restart fresh instead",
          now: this.now(),
        });
        return true;
      }
    }

    const outcome: JobOutcome = isProxiedKind(job.kind)
      ? await this.runProxiedJob(job, job.kind)
      : await this.runGenerateJob(job);

    if (outcome.kind === "requeue") {
      // The ONE bound `claimNextJob` cannot see in advance — preview pool
      // capacity, shared with non-job traffic. See this module's own top
      // comment for why this is the sole remaining requeue-after-claim path.
      requeueJob(this.db, job.id);
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

    // WHOLE-BRANCH REVIEW, CRITICAL 2 — "a user can hand their regen bill to
    // the operator."
    //
    // `compiler-routes.ts` gates the four billable `/__*` entries with
    // `requireApiKey` at ENQUEUE. Before the job model, the check and the
    // `pool.acquire` that consumed its answer sat in ONE synchronous request,
    // so the window between them was a millisecond. A job turns that window
    // into a job LIFETIME: a user can save a key, `POST /__regen` (202, the
    // key check passes), then `DELETE /api/key` seconds or minutes before
    // this worker claims the job.
    //
    // Nothing downstream catches that. `PreviewPool.buildChildEnv`
    // DELIBERATELY swallows `MissingApiKeyError` and spawns a scrubbed,
    // keyless child (previewing is free — its own comment says so), and
    // `acquire`'s fingerprint check respawns a warm child KEYLESS rather than
    // refusing. `config.py`'s `load_dotenv(override=False)` then lets the
    // absent injected key fall through to `orchestrator/.env`, so the run
    // spends the OPERATOR's key, recorded against the user's project, with
    // zero `usage_event` rows. That is the 4c-2 "operator pays" bug reopened
    // through a new door.
    //
    // `runGenerateJob` is not affected — `buildAgentEnv` THROWS there rather
    // than falling back — which is exactly the asymmetry that made this
    // invisible to a per-task review: only the five proxied kinds degrade
    // silently. `assertApiKeyUsable` exists precisely for this and
    // deliberately does NOT catch `MissingApiKeyError` (see its own doc
    // comment), so it is the right primitive rather than a new one.
    //
    // Billable kinds only: `export` spends nothing and must keep working for
    // a keyless user, the same rule `compiler-routes.ts` applies when it
    // wraps ONLY `entry.billable` entries in `requireApiKey`.
    if (BILLABLE_JOB_KINDS.includes(kind)) {
      try {
        this.pool.assertApiKeyUsable(job.userId);
      } catch (err) {
        // Mirrors `compiler-routes.ts`'s `requireApiKey` mapping, translated
        // from statuses to a job outcome: the two user-actionable errors
        // (missing key, disabled account) carry their own message, and the
        // two operator-facing ones are ALSO logged, because a user cannot act
        // on either and nothing else would surface them. Anything unexpected
        // becomes a failed job too rather than being rethrown — a throw out of
        // here would escape `runOnce`'s own terminal-state handling and leave
        // the job stuck `running` forever, which is strictly worse than a
        // clean failure with a generic message.
        if (err instanceof UndecryptableApiKeyError || err instanceof UnknownUserError) {
          console.error(`[job-worker] job ${job.id} (user ${job.userId}): ${err.message}`);
        } else if (!(err instanceof MissingApiKeyError) && !(err instanceof DisabledUserError)) {
          console.error(`[job-worker] job ${job.id}: unexpected API-key failure: ${redactSecrets(messageOf(err))}`);
        }
        return { kind: "failed", error: redactSecrets(messageOf(err)) };
      }
    }

    // Task 7: recorded BEFORE the actual exchange runs, not after — a job
    // that fails past this point must still carry the run id/code version
    // that its (partially) real execution used, so a later resume can
    // compare against them. `job.runId` is already set only for a job
    // created by resume (copied from the job it resumes); every other job
    // derives it here from the project directory, exactly as
    // `compiler/src/regen-api.ts`'s own `basename(root)` already does deep
    // inside the child, so the two always agree.
    const proxiedRunId = job.runId ?? project.directory;
    // Task-7-review finding 5: checked here, BEFORE recordJobRun, so an
    // unsafe shape becomes a normal failed job rather than an uncaught throw
    // out of recordJobRun (which would leave this job stuck `running`
    // forever — nothing past a throw here would ever call
    // finishJob/requeueJob for it). See isSafeRunId's own comment for why
    // this is checked at all despite being unreachable via any path that
    // exists today.
    if (!isSafeRunId(proxiedRunId)) {
      return { kind: "failed", error: "job's run id has an unsafe shape" };
    }
    recordJobRun(this.db, job.id, { runId: proxiedRunId, codeVersion: this.codeVersion });

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
    // Task 7: same rule as runProxiedJob's own — recorded before the
    // subprocess spawns, and used (not `project.directory` directly) as the
    // actual `--run-id` value below, so a resumed job (whose `job.runId` was
    // copied from the job it resumes) passes Kitaru the SAME run id its
    // earlier, partial execution used.
    const runId = job.runId ?? project.directory;
    // Task-7-review finding 5 — see runProxiedJob's own identical guard for
    // the full reasoning (checked before recordJobRun, never after, so an
    // unsafe shape becomes a normal failed job rather than a job stuck
    // `running` forever behind an uncaught throw).
    if (!isSafeRunId(runId)) {
      return { kind: "failed", error: "job's run id has an unsafe shape" };
    }
    recordJobRun(this.db, job.id, { runId, codeVersion: this.codeVersion });

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
        "--run-id", runId,
      ], { jobId: job.id, usagePath });
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

  /**
   * `track` is what `stop()` needs to be able to terminate this child
   * (whole-branch review, FINDING C). It is registered synchronously, the
   * moment the child exists, and cleared when the promise settles — either
   * way — so `activeOrchestratorRun` never names a process that has already
   * gone. Only ONE can be live at a time, which is a real property rather
   * than an assumption: `start()`'s ticks never overlap, and a `generate` is
   * the whole of its own tick.
   */
  private runOrchestratorProcess(
    env: NodeJS.ProcessEnv,
    args: string[],
    track: { jobId: string; usagePath: string },
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = this.orchestratorSpawnFn("uv", args, { cwd: this.orchestratorDir, env });
      this.activeOrchestratorRun = { child, jobId: track.jobId, usagePath: track.usagePath };
      const settle = (fn: () => void): void => {
        this.activeOrchestratorRun = undefined;
        fn();
      };
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (err: Error) => settle(() => reject(err)));
      child.on("exit", (code: number | null) => settle(() => resolve({ stdout, stderr, code })));
    });
  }
}
