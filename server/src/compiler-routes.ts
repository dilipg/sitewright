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
 */
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { USAGE_ID_HEADER, usageLogPathFor } from "../../compiler/src/usage-log-path.ts";
import { ingestUsageLog } from "./ingest-usage.ts";
import { forwardToPreview } from "./preview-forward.ts";
import type { PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { requireBudget } from "./require-budget.ts";
import { requireProject } from "./require-project.ts";
import type { Route } from "./router.ts";

/** Every registry entry that names one of the compiler's own `/__*` endpoints. */
const COMPILER_ENDPOINTS = PROJECT_SCOPED_ENDPOINTS.filter((entry) => entry.path.startsWith("/__"));

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
    // unauthenticated or non-owner request never reaches requireBudget, let
    // alone the pool. requireBudget wraps the forward only for a billable
    // entry — a non-billable one (notably /__export and
    // /__export-download: the exporter is deterministic, and refusing an
    // export over the cap would strand a user's finished work behind a
    // bill) reaches `forward` directly, ungated, and never gets a usage id.
    handler: requireProject(
      db,
      entry.idFrom,
      entry.billable ? requireBudget(db, billableForward) : forward,
    ),
  }));
}
