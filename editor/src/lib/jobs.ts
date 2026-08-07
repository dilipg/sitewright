/**
 * Submitting long-running work as a job and polling for its outcome
 * (slice 5, job-model design doc: docs/superpowers/specs/
 * 2026-08-06-job-model-design.md).
 *
 * This editor talks to TWO different backends behind the same `PREVIEW_URL`,
 * and `enqueueAndPoll` is the one place that has to know it:
 *
 *  - The HOSTED server's converted endpoints (`/__regen`, `/__regen-page`,
 *    `/__add-section`, `/__edit-prompt`, `/__export`, and `POST
 *    /api/generate`, though nothing in this editor calls that one yet)
 *    answer **202 `{ jobId }`**. The work has not happened yet — the design
 *    doc's own words: "202, not 200. ... saying 200 would be a lie a client
 *    could reasonably act on." There is a real job row to poll:
 *    `GET /api/jobs/:id` until `status` reaches a terminal value.
 *
 *  - `compiler/scripts/preview.ts` — the LOCAL, unauthenticated preview
 *    server every milestone-7 e2e spec and every day-to-day editor session
 *    runs against — has no job table and never will (the design doc: "No
 *    compiler changes"). It answers the very same paths SYNCHRONOUSLY,
 *    still with 200 on success (and a 4xx/5xx of its own on a validation or
 *    internal error): the work has already finished by the time the
 *    response arrives, and the response body itself IS the outcome.
 *
 * The discriminator is the status code the design deliberately reserved for
 * "a job now exists, go poll for it": 202, and nothing else. Any other
 * status — 200 from the local server, or a hosted-server refusal answered
 * before a job was ever created (402 over the spend cap, 429 over the
 * per-user job bound, 400 on a malformed body) — is read exactly the way a
 * bare `fetch(...).then(r => r.json())` always was: parse the body, hand it
 * back as an already-finished outcome. This is not sniffing which backend
 * answered; it is trusting the one signal the design put there for exactly
 * this purpose.
 *
 * THE TRAP: a job's `status` reaching `"succeeded"` means the REQUEST
 * completed, not that the work passed. A regen that ran to completion but
 * failed a validation gate is still a `"succeeded"` job whose OWN
 * `result.passed` is `false` — `server/src/job-worker.ts`'s `runProxiedJob`
 * stores the child's response body verbatim as `result` for any 2xx
 * exchange, gate failures included. Every call site must keep reading
 * `passed` / `failureReport` / `orphanedOverrides` / `sectionId` / `error`
 * out of `result` exactly as it read them out of the raw response body
 * before this helper existed. `enqueueAndPoll` deliberately does NOT try to
 * interpret `result` itself — that would require knowing five different
 * response shapes, one per endpoint, and getting even one wrong would hide
 * a real gate failure behind a false "succeeded".
 *
 * A SECOND, RELATED TRAP lives in the POLL LOOP itself, not just at the
 * call sites: a poll response was previously trusted by an `as` cast rather
 * than checked. A five-minute job outlives plenty of things that can go
 * wrong mid-poll and have nothing to do with the job itself — the job row
 * disappearing (a 404, `job-routes.ts`'s uniform "gone or never yours"
 * response), a session expiring (a 401), a transient 500. None of those
 * bodies carry a `status` field, so an unchecked cast made `job.status`
 * `undefined`, which is neither a known non-terminal value nor a valid
 * terminal one — and the old code fell straight out of the polling loop and
 * returned it as a TERMINAL outcome anyway, with `result: undefined`. Every
 * call site then either read `.error` off `undefined` (a `TypeError`,
 * rendering a flow's own "failed" UI while the job could still be running —
 * exactly the lie `interrupted`-handling exists to prevent, arrived at by a
 * different route) or, for `runExport`, handed `undefined` straight to
 * `setExportOutcome`, which passed the `!== null` JSX guard and crashed the
 * app reading `.ok` off `undefined`. The fix: reject on `!response.ok`, and
 * reject on any `status` outside the five known values, rather than ever
 * returning either as a fabricated terminal `JobOutcome`. A rejection here
 * lands in the exact same `catch` block every call site already had for a
 * network failure — no new failure surface, no fabricated success.
 */

/** The two non-terminal states a job can be polled in. */
export type PollingJobStatus = "queued" | "running";

/**
 * The three states a job can finish in. `"interrupted"` is NOT a synonym
 * for `"failed"`: it is what a server restart mid-run produces, and the
 * work may have completed — the server genuinely cannot tell. A caller must
 * not report it as a failure; see this module's own header comment and the
 * job-model design doc's "Crash recovery" section.
 */
export type TerminalJobStatus = "succeeded" | "failed" | "interrupted";

/** Delivered once per poll, only while the job has not yet reached a
 *  terminal status — the only honest progress signal a job offers (design
 *  doc, "Accepted losses": "the UI can show 'running' and elapsed time, not
 *  'generating section 3 of 6'"). `elapsedMs` is measured from this
 *  function's own POST, not from the job's `createdAt`/`startedAt` — a
 *  caller only ever needs "how long has MY submission been waiting", and
 *  the two differ only by scheduling noise this UI has no use for. */
export interface JobStatusUpdate {
  status: PollingJobStatus;
  elapsedMs: number;
}

/** What `enqueueAndPoll` resolves with, whichever backend answered it. */
export interface JobOutcome {
  status: TerminalJobStatus;
  /** For `"succeeded"`, the child's parsed response body — the same object
   *  a direct `fetch(...).then(r => r.json())` produced before this helper
   *  existed. Read defensively: for `"failed"`/`"interrupted"` it is
   *  normally absent. */
  result?: unknown;
  /** A redacted message. Present on `"failed"`; never on `"succeeded"` or
   *  `"interrupted"` (job-model design doc's own schema). */
  error?: string;
}

export interface EnqueueAndPollOptions {
  onStatus?: (update: JobStatusUpdate) => void;
  /** Default 2000ms — the design doc's own figure ("a few hundred requests
   *  for a five-minute generation"). Overridable so tests do not have to
   *  wait on a real 2s timer. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests, in place of a real `setTimeout` delay. */
  wait?: (ms: number) => Promise<void>;
  /** Injectable for tests, in place of the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

/** The only five values a job's `status` is ever allowed to hold — anything
 *  else means the response wasn't actually a job status at all (a 404's
 *  `{error: "not found"}`, a 401's `{error: "..."}`, a bare 500 body). */
const KNOWN_JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);

function isKnownJobStatus(value: unknown): value is PollingJobStatus | TerminalJobStatus {
  return typeof value === "string" && KNOWN_JOB_STATUSES.has(value);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * POSTs `body` (JSON-encoded) to `url` and resolves with the eventual
 * outcome — see this module's header comment for the full discrimination
 * rationale. The poll URL is derived from the ENQUEUE url's own origin
 * (`new URL("/api/jobs/" + jobId, url)`), never hardcoded, so this function
 * needs no separate configuration for which backend it is talking to.
 */
export async function enqueueAndPoll(
  url: string,
  body: unknown,
  options: EnqueueAndPollOptions = {},
): Promise<JobOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const response = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status !== 202) {
    // No job was ever created — either the local server's own synchronous
    // 200 (the work already happened), or a hosted-server refusal answered
    // before enqueue (402/429/400, itself an `{error: "..."}` body every
    // caller already knows how to read). Either way the body IS the
    // outcome, exactly as a bare fetch-and-parse always returned it.
    const result: unknown = await response.json();
    return { status: "succeeded", result };
  }

  const { jobId } = (await response.json()) as { jobId: string };
  const pollUrl = new URL(`/api/jobs/${jobId}`, url).toString();
  const startedAt = now();

  for (;;) {
    const jobResponse = await doFetch(pollUrl);
    // A mid-poll 404 (the job row is gone or was never this session's --
    // job-routes.ts answers both uniformly), a 401 (a session expiring
    // during a run that can genuinely run several minutes), or a 500 all
    // carry a JSON body with no `status` field. Rejecting here, rather than
    // trying to interpret the body, is what stops that body from being
    // read as a fabricated terminal outcome below.
    if (!jobResponse.ok) {
      throw new Error(`job status poll failed: HTTP ${String(jobResponse.status)}`);
    }
    const job = (await jobResponse.json()) as {
      status?: unknown;
      result?: unknown;
      error?: string;
    };
    // The `as` cast above asserts a shape; this checks one. An `ok` 200
    // whose body simply isn't a job (or whose `status` is some future value
    // this build doesn't know about yet) is exactly as dangerous as a 404 --
    // it must not fall out of the loop and be returned as terminal.
    if (!isKnownJobStatus(job.status)) {
      throw new Error(`job status poll returned an unrecognised status: ${JSON.stringify(job.status)}`);
    }
    if (job.status === "queued" || job.status === "running") {
      options.onStatus?.({ status: job.status, elapsedMs: now() - startedAt });
      await wait(pollIntervalMs);
      continue;
    }
    return { status: job.status, result: job.result, error: job.error };
  }
}

/** "Running… Ns" is the only honest progress line a job-backed operation
 *  can show — no fabricated percentage, no synthetic step count (design
 *  doc's own accepted loss). Whole seconds, floored rather than rounded, so
 *  the displayed count never claims a second has elapsed before it has. */
export function formatElapsedSeconds(elapsedMs: number): string {
  return `${String(Math.max(0, Math.floor(elapsedMs / 1000)))}s`;
}
