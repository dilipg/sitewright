// server/src/compiler-routes.ts
/**
 * The compiler's `/__*` endpoints, mounted.
 *
 * They are NOT reimplemented here. Each already exists as Vite plugin
 * middleware inside the project's own preview child (compiler/src/
 * regen-api.ts, plan-api.ts, export-api.ts, preview.ts) — the spec's "two
 * composition roots over the same handlers". This module adds authorization
 * (and, for the endpoints that start a model call, the spend cap) by
 * composition, then forwards bytes to the child exactly like
 * preview-routes.ts already does.
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
 * Task 3 ("attribute the spend") adds a second forward, `billableForward`,
 * used only for the four `billable: true` entries. It supplies
 * `forwardToPreview`'s `billable` hook: a fresh 32-hex-char id per request
 * (`randomBytes(16).toString("hex")` — exactly what `isValidUsageId`
 * accepts, pinned by a test), sent as `x-webgen-usage-id` on the forwarded
 * request, then — in the same `finally` as `pool.release`, so it runs even
 * when the proxy call rejected — ingested from `usageLogPathFor(id)` and
 * deleted. `ingestUsageLog` never throws (it was built for exactly this call
 * site) and is NOT idempotent, which is why the id is generated once per
 * request and the file is removed immediately after: re-ingesting the same
 * path would double a real user's bill. A non-billable entry keeps using the
 * plain `forward` with no id at all — generating one nobody writes to would
 * create a file an ingest can only ever find empty.
 *
 * Task 4 closes two gaps, both scoped to the four billable entries only —
 * `requireProject`'s ownership check and `requireBudget`'s spend cap already
 * cover every entry, but these two exist ONLY where a model call actually
 * happens:
 *
 * `requireApiKey` maps `agent-env.ts`'s `MissingApiKeyError`/
 * `DisabledUserError`/`UnknownUserError` and `api-keys.ts`'s
 * `UndecryptableApiKeyError` to 400/403/500/500 respectively, via
 * `PreviewPool.assertApiKeyUsable` — called BEFORE the request ever reaches
 * `acquire`/proxy, so a keyless user gets an actionable 400 instead of the
 * orchestrator failing on a missing key deep inside a subprocess and
 * surfacing as an opaque 500. Deliberately NOT added to `forwardToPreview`
 * itself (shared with `preview-routes.ts`'s `/preview/:projectId/*`,
 * task 3's module comment): previewing and exporting spend nothing and must
 * keep working for a keyless user (`PreviewPool.buildChildEnv` already falls
 * back to a scrubbed, keyless child env for exactly that reason), so mapping
 * `MissingApiKeyError` in the shared handler would refuse those endpoints
 * too. `UndecryptableApiKeyError` is logged (never the key itself — only the
 * typed error's own message, which names none): the ciphertext no longer
 * opening under the current master key is an operator problem, not a user
 * one, and `getApiKeyFingerprint` cannot detect it (it never touches the
 * master key), so this log line is the only signal an operator gets.
 *
 * `requireBillableSlot` bounds the concurrent-start multiplier on the spend
 * cap: spend lands in `usage_event` only at ingest (after a run finishes),
 * so N billable requests in flight at once for one user all evaluate
 * `checkSpendCap` against the same pre-run total. `PreviewPool.
 * reserveBillableSlot`/`releaseBillableSlot` hold a small per-user in-flight
 * count; a reservation is taken before `requireBudget` runs and released in
 * a `finally` — so it is held (briefly) even for a request `requireBudget`
 * itself goes on to refuse, and released whether the eventual forward
 * succeeds, throws, or never runs at all.
 */
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { USAGE_ID_HEADER, usageLogPathFor } from "../../compiler/src/usage-log-path.ts";
import { DisabledUserError, MissingApiKeyError, UnknownUserError } from "./agent-env.ts";
import { UndecryptableApiKeyError } from "./api-keys.ts";
import { ingestUsageLog } from "./ingest-usage.ts";
import { forwardToPreview } from "./preview-forward.ts";
import { MAX_BILLABLE_IN_FLIGHT_PER_USER, type PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { requireBudget } from "./require-budget.ts";
import { requireProject, type ProjectHandler } from "./require-project.ts";
import { sendJson, type Route } from "./router.ts";

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

/**
 * Bounds task 4's second gap: refuses beyond `MAX_BILLABLE_IN_FLIGHT_PER_USER`
 * concurrent billable requests for one user with 429 — not 402, because
 * retrying genuinely helps here once the in-flight run finishes, unlike the
 * spend cap's 402 where no amount of retrying helps until the window rolls.
 * `release` runs in a `finally` so a leaked reservation (freed only on
 * success) cannot permanently shrink a user's allowance after one failure.
 */
function requireBillableSlot(pool: PreviewPool, inner: ProjectHandler): ProjectHandler {
  return async (req, res, ctx) => {
    if (!pool.reserveBillableSlot(ctx.user.id)) {
      sendJson(res, 429, {
        error: `at most ${MAX_BILLABLE_IN_FLIGHT_PER_USER} billable requests may run at once for this account; wait for one to finish and retry`,
      });
      return;
    }
    try {
      await inner(req, res, ctx);
    } finally {
      pool.releaseBillableSlot(ctx.user.id);
    }
  };
}

export function compilerRoutes(deps: { db: DatabaseSync; pool: PreviewPool }): Route[] {
  const { db, pool } = deps;
  const forward = forwardToPreview(pool);
  const billableForward = forwardToPreview(pool, {
    billable: (ctx) => {
      const usageId = randomBytes(16).toString("hex");
      return {
        setHeaders: { [USAGE_ID_HEADER]: usageId },
        after: () => {
          const path = usageLogPathFor(usageId);
          // Never throws, by contract (ingest-usage.ts) — safe to call
          // unconditionally, including for a run that wrote no log at all
          // (the "no model calls" case), which is a legitimate no-op, not
          // an error.
          ingestUsageLog(db, { path, userId: ctx.user.id, projectId: ctx.project.id, now: Date.now() });
          try {
            unlinkSync(path);
          } catch {
            // Nothing to delete — either the child wrote no log for this
            // request, or it's already gone. Either way, ingest above
            // already ran (or correctly no-opped), so there is nothing left
            // to protect by throwing here.
          }
        },
      };
    },
  });

  return COMPILER_ENDPOINTS.map((entry) => ({
    method: entry.method,
    path: entry.path,
    // requireProject runs first (session + ownership), so an
    // unauthenticated or non-owner request never reaches requireApiKey,
    // requireBillableSlot, requireBudget, or the pool. All three of those
    // wrap the forward only for a billable entry — a non-billable one
    // (notably /__export and /__export-download: the exporter is
    // deterministic, and refusing an export over the cap would strand a
    // user's finished work behind a bill) reaches `forward` directly,
    // ungated, never checked for a key, and never gets a usage id. Order
    // among the three billable-only wrappers: the key check runs first
    // (a precondition with no side effect — no point holding a concurrency
    // slot or consulting the cap for a request that cannot succeed anyway),
    // then the in-flight reservation, then the spend cap, then the forward
    // itself.
    handler: requireProject(
      db,
      entry.idFrom,
      entry.billable
        ? requireApiKey(pool, requireBillableSlot(pool, requireBudget(db, billableForward)))
        : forward,
    ),
  }));
}
