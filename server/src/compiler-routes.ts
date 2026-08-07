// server/src/compiler-routes.ts
/**
 * The compiler's `/__*` endpoints, mounted.
 *
 * Most are NOT reimplemented here. Each already exists as Vite plugin
 * middleware inside the project's own preview child (compiler/src/
 * regen-api.ts, plan-api.ts, export-api.ts, preview.ts) — the spec's "two
 * composition roots over the same handlers". This module adds authorization
 * (and, for the endpoints that start a model call, the spend cap) by
 * composition, then forwards bytes to the child exactly like
 * preview-routes.ts already does — for every entry EXCEPT the five the job
 * model (slice 5) converts to async, below.
 *
 * The path forwarded is `req.url` VERBATIM — query string and all. Two
 * reasons, both learned the hard way in 4c-1 (see preview-routes.ts's module
 * comment for the full account): the child's own middleware matches on
 * `req.url.split("?")[0]`, so `/__regen?project=X` forwarded whole matches
 * `/__regen` inside the child; and stripping any part of it risks the same
 * Vite-`base`-redirect loop `/preview/:projectId/*` already had to avoid.
 * There is no prefix to strip here in the first place — these routes are
 * literal paths, not `/preview/<id>/...` — but the rule is the same: never
 * normalise, rebuild, or strip anything from the forwarded path.
 *
 * The endpoint list is DERIVED from project-registry.ts rather than
 * retyped: every `/__*` entry in `PROJECT_SCOPED_ENDPOINTS` becomes one
 * mounted route here. A second hand-written list is exactly the drift the
 * registry exists to prevent, and a route mounted here without a registry
 * entry would fail project-registry.test.ts's partition check the moment
 * it existed.
 *
 * The inner acquire/retain/proxy/release/error-mapping handler is
 * `preview-forward.ts`'s `forwardToPreview`, shared with
 * `preview-routes.ts` rather than duplicated here — the two used to carry
 * byte-identical copies of this security-relevant sequence, which is
 * exactly the kind of duplication that lets a later fix (mapping
 * `MissingApiKeyError`/`DisabledUserError`) land in one file and silently
 * miss the other. Needs no `path` argument, unlike a route with its own
 * `:param`: a compiler endpoint's own path (`/__regen`, etc.) already
 * carries no project id — that arrives via the query string, per
 * `BY_QUERY` — so `req.url` is already exactly what the child's middleware
 * expects, with no per-route path construction needed.
 *
 * Task 4 closes two gaps, both scoped to the four billable entries only —
 * `requireProject`'s ownership check and `requireBudget`'s spend cap already
 * cover every entry, but these two exist ONLY where a model call actually
 * happens:
 *
 * `requireApiKey` maps `agent-env.ts`'s `MissingApiKeyError`/
 * `DisabledUserError`/`UnknownUserError` and `api-keys.ts`'s
 * `UndecryptableApiKeyError` to 400/403/500/500 respectively, via
 * `PreviewPool.assertApiKeyUsable` — called BEFORE the request is even
 * enqueued, so a keyless user gets an actionable 400 immediately instead of
 * a job that will simply fail later once the worker gets to it.
 * `assertApiKeyUsable` only ever consults the DATABASE, though — on its own
 * it says nothing about a warm child whose key no longer matches (a keyless
 * spawn whose owner has since saved one, a rotated key, ...), which does NOT
 * fail loudly: the orchestrator's own dotenv fallback (`override=False`)
 * means an absent injected key silently spends the OPERATOR's instead. That
 * gap is closed separately, in `PreviewPool.acquire()` itself (FIX 2, a
 * whole-branch review): every reuse of a warm entry re-checks the child's
 * key fingerprint against the owner's current one and, if idle, respawns
 * before the job's own eventual proxy call ever reaches it. Deliberately NOT
 * added to `forwardToPreview` itself (shared with `preview-routes.ts`'s
 * `/preview/:projectId/*`): previewing and exporting spend nothing and must
 * keep working for a keyless user (`PreviewPool.buildChildEnv` already falls
 * back to a scrubbed, keyless child env for exactly that reason), so mapping
 * `MissingApiKeyError` in the shared handler would refuse those endpoints
 * too. `UndecryptableApiKeyError` is logged (never the key itself — only the
 * typed error's own message, which names none): the ciphertext no longer
 * opening under the current master key is an operator problem, not a user
 * one, and `getApiKeyFingerprint` cannot detect it (it never touches the
 * master key), so this log line is the only signal an operator gets.
 *
 * SLICE 5 (the job model) converts the five long-running entries —
 * `/__regen`, `/__regen-page`, `/__add-section`, `/__edit-prompt`,
 * `/__export` — from proxying inline to ENQUEUING a job and answering 202
 * `{jobId}` immediately. `entry.async` (project-registry.ts) is what marks
 * these five; everything else keeps proxying synchronously via `forward`,
 * completely unchanged.
 *
 * This is a real simplification, not just a rename: the usage-id-header /
 * ingest-on-completion machinery that USED to live in this file (a
 * `billableForward` built on `forwardToPreview`'s own `billable` hook) moved
 * OUT, whole, into `job-worker.ts`'s `runProxiedJob` — it calls
 * `forwardToPreview` itself, over a synthetic loopback connection, with the
 * IDENTICAL hook shape (same usage-id generation, same "same finally as
 * release", same skip-on-incomplete-exchange rule), so every property that
 * machinery was reviewed for carries over unchanged; it is relocated, not
 * reimplemented (see job-worker.ts's own module comment, and the design doc
 * this slice implements: "`retain`/`release`, the usage-log id, and ingest
 * move unchanged in shape into the worker"). The five async entries never
 * touch `pool.acquire` at all from THIS layer any more — there is nothing
 * left here to hold a preview slot, generate a usage id, or ingest a log for
 * — so `requireBillableSlot` (the old concurrent-start-multiplier bound,
 * `MAX_BILLABLE_IN_FLIGHT_PER_USER`) is gone too: enqueuing is a single fast
 * INSERT, not a held connection, so there is nothing left for that reservation
 * to bound. Its replacement lives in the job layer instead —
 * `jobs.ts`'s `claimNextJob` refuses to hand a user more than
 * `MAX_ACTIVE_JOBS_PER_USER` (2) concurrently RUNNING jobs, "today's in-flight
 * reservation, same value, same meaning" per that constant's own comment.
 * `PreviewPool.reserveBillableSlot`/`releaseBillableSlot` themselves are
 * untouched and still directly unit-tested (preview-pool.test.ts) — only this
 * file's WIRING of them is gone, because nothing here holds a slot across an
 * `await` boundary any more.
 *
 * `kind` for each async entry is resolved by `jobKindForAsyncPath`, an
 * EXHAUSTIVE switch rather than a `Record<string, JobKind>` lookup. Task 1's
 * review flagged that `JobKind` is a compile-time union only — nothing stops
 * a runtime string that does not match one of its members from reaching
 * `createJob`'s INSERT — and a plain object/Record lookup degrades silently
 * to `undefined` for an unmapped key. This throws instead, and does so once
 * per async entry when `compilerRoutes()` itself runs (route-table
 * construction, not per-request), so a future async registry entry added
 * without a matching case here fails the moment the server boots (or a test
 * calls `compilerRoutes()`), never silently at whatever later moment a
 * request happens to hit it.
 */
import type { DatabaseSync } from "node:sqlite";
import { DisabledUserError, MissingApiKeyError, UnknownUserError } from "./agent-env.ts";
import { UndecryptableApiKeyError } from "./api-keys.ts";
import { createJob, type JobKind } from "./jobs.ts";
import { forwardToPreview } from "./preview-forward.ts";
import type { PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { requireBudget } from "./require-budget.ts";
import { requireProject, type ProjectHandler } from "./require-project.ts";
import { readJsonBody, sendJson, type Route } from "./router.ts";

/** Every registry entry that names one of the compiler's own `/__*` endpoints. */
const COMPILER_ENDPOINTS = PROJECT_SCOPED_ENDPOINTS.filter((entry) => entry.path.startsWith("/__"));

/**
 * Maps `PreviewPool.assertApiKeyUsable`'s four typed failures to a status —
 * see the module comment. Anything else (there is nothing else this specific
 * call can throw today) is rethrown to the router's own catch-all, which
 * answers a generic 500 with no detail, the same as any other unanticipated
 * failure.
 */
function requireApiKey(pool: PreviewPool, inner: ProjectHandler): ProjectHandler {
  return async (req, res, ctx) => {
    try {
      pool.assertApiKeyUsable(ctx.user.id);
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (err instanceof DisabledUserError) {
        sendJson(res, 403, { error: err.message });
        return;
      }
      if (err instanceof UndecryptableApiKeyError) {
        console.error(`[compiler-routes] undecryptable API key for user ${ctx.user.id}: ${err.message}`);
        sendJson(res, 500, { error: err.message });
        return;
      }
      if (err instanceof UnknownUserError) {
        console.error(`[compiler-routes] ${err.message} (user ${ctx.user.id})`);
        sendJson(res, 500, { error: err.message });
        return;
      }
      throw err;
    }
    await inner(req, res, ctx);
  };
}

/** See this module's own top comment. Exhaustive on purpose — an unmapped path throws rather than reaching `createJob` with a bad `kind`. */
function jobKindForAsyncPath(path: string): JobKind {
  switch (path) {
    case "/__regen": return "regen";
    case "/__regen-page": return "regen-page";
    case "/__add-section": return "add-section";
    case "/__edit-prompt": return "edit-prompt";
    case "/__export": return "export";
    default:
      throw new Error(`compiler-routes: no job kind mapped for async endpoint "${path}"`);
  }
}

const BAD_JSON_BODY = { error: "request body must be valid JSON within the size limit" };

/**
 * Enqueues `kind` against the request's own project and user, storing the
 * request body verbatim (re-serialized after parsing, not the raw bytes) as
 * `request_json` — the exact payload `job-worker.ts`'s `runProxiedJob` will
 * later replay to the child. No shape validation beyond "valid JSON, within
 * the body-size limit" happens here: that is unchanged from today (the CHILD
 * has always been the one that validates a `/__regen`-shaped body, and still
 * is — this endpoint only decides whether to run it now or later).
 */
function enqueueHandler(db: DatabaseSync, kind: JobKind): ProjectHandler {
  return async (req, res, ctx) => {
    let parsed: unknown;
    try {
      parsed = await readJsonBody(req);
    } catch {
      sendJson(res, 400, BAD_JSON_BODY);
      return;
    }
    const job = createJob(db, {
      userId: ctx.user.id,
      projectId: ctx.project.id,
      kind,
      requestJson: JSON.stringify(parsed),
      now: Date.now(),
    });
    sendJson(res, 202, { jobId: job.id });
  };
}

export function compilerRoutes(deps: { db: DatabaseSync; pool: PreviewPool }): Route[] {
  const { db, pool } = deps;
  const forward = forwardToPreview(pool);

  return COMPILER_ENDPOINTS.map((entry) => {
    const inner: ProjectHandler = entry.async
      ? enqueueHandler(db, jobKindForAsyncPath(entry.path))
      : forward;
    return {
      method: entry.method,
      path: entry.path,
      // requireProject runs first (session + ownership), so an
      // unauthenticated or non-owner request never reaches requireApiKey,
      // requireBudget, the job table, or the pool. Only a `billable` entry
      // gets the key check + spend cap wrapped around it — a non-billable
      // one (notably /__export, async but not billable, and
      // /__export-download: the exporter is deterministic, and refusing an
      // export over the cap would strand a user's finished work behind a
      // bill) reaches `inner` directly, ungated, never checked for a key.
      handler: requireProject(
        db,
        entry.idFrom,
        entry.billable ? requireApiKey(pool, requireBudget(db, inner)) : inner,
      ),
    };
  });
}
