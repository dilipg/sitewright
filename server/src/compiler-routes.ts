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
 */
import type { DatabaseSync } from "node:sqlite";
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

  return COMPILER_ENDPOINTS.map((entry) => ({
    method: entry.method,
    path: entry.path,
    // requireProject runs first (session + ownership), so an
    // unauthenticated or non-owner request never reaches requireBudget, let
    // alone the pool. requireBudget wraps `forward` only for a billable
    // entry — a non-billable one (notably /__export and
    // /__export-download: the exporter is deterministic, and refusing an
    // export over the cap would strand a user's finished work behind a
    // bill) reaches `forward` directly, ungated.
    handler: requireProject(db, entry.idFrom, entry.billable ? requireBudget(db, forward) : forward),
  }));
}
