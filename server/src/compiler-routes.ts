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
 */
import type { DatabaseSync } from "node:sqlite";
import { PreviewCapacityError, type PreviewPool } from "./preview-pool.ts";
import { PROJECT_SCOPED_ENDPOINTS } from "./project-registry.ts";
import { proxyHttp } from "./preview-proxy.ts";
import { requireBudget } from "./require-budget.ts";
import { requireProject, type ProjectHandler } from "./require-project.ts";
import { sendJson, type Route } from "./router.ts";

/** Every registry entry that names one of the compiler's own `/__*` endpoints. */
const COMPILER_ENDPOINTS = PROJECT_SCOPED_ENDPOINTS.filter((entry) => entry.path.startsWith("/__"));

/**
 * Builds the one inner handler every compiler route shares: acquire the
 * project's preview child, retain it for the duration of one proxied
 * request, forward `req.url` unmodified, and release in a `finally` — the
 * exact acquire/retain/proxy/release/error-mapping shape `preview-routes.ts`
 * uses for its own single route, extracted here so mounting a dozen
 * compiler endpoints does not mean writing this sequence a dozen times.
 * `release` in a `finally` is load-bearing on its own: without it, a client
 * that disconnects mid-regen (or a proxy call that somehow throws) pins the
 * preview forever and `MAX_PREVIEWS` leaks down over the life of the
 * process.
 *
 * Needs no `path` argument, unlike `preview-routes.ts`'s handler: a compiler
 * endpoint's own path (`/__regen`, etc.) already carries no project id —
 * that arrives via the query string, per `BY_QUERY` — so `req.url` is
 * already exactly what the child's middleware expects for every one of
 * these routes, with no per-route path construction needed.
 */
function makeForwardHandler(pool: PreviewPool): ProjectHandler {
  return async (req, res, ctx) => {
    let preview;
    try {
      preview = await pool.acquire(ctx.project, ctx.user.id);
    } catch (error) {
      // Same mapping as preview-routes.ts: capacity is the caller's problem
      // to act on and says so; anything else gets a generic message, since
      // the underlying error can carry a stack trace or an
      // environment-derived detail that must never reach a response body.
      sendJson(res, error instanceof PreviewCapacityError ? 503 : 500, {
        error: error instanceof PreviewCapacityError
          ? error.message
          : "could not start the preview",
      });
      return;
    }
    pool.retain(ctx.project.id);
    try {
      // req.url, unmodified — see the module comment for why.
      await proxyHttp({ req, res, port: preview.port, path: req.url ?? "/" });
    } finally {
      pool.release(ctx.project.id);
    }
  };
}

export function compilerRoutes(deps: { db: DatabaseSync; pool: PreviewPool }): Route[] {
  const { db, pool } = deps;
  const forward = makeForwardHandler(pool);

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
