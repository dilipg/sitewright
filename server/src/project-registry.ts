// server/src/project-registry.ts
/**
 * Every endpoint the hosted server exposes that belongs to ONE project, and
 * how to find that project's id in the request.
 *
 * This list exists so the authorization test can be table-driven (spec,
 * Testing): a new project-scoped endpoint added without a rule fails the test
 * rather than shipping unguarded. It is a declaration, not a router — the
 * router is still the allowlist, and these entries have to be registered there
 * too before anything is reachable.
 *
 * TWO ENTRIES ARE NOT IN THE SPEC'S OWN LIST — /__plan/section-brief and
 * /__plan/approve (compiler/src/plan-api.ts:39,63). The spec names ten
 * project-scoped endpoints; the code has twelve. Both of these read and write
 * one project's plan, so they are project-scoped by any reading, and omitting
 * them under deny-by-default would leave plan approval unreachable. Raised for
 * a human ruling rather than resolved by editing the spec.
 *
 * `billable` marks an endpoint that STARTS a model call, and so must be
 * wrapped in requireBudget when it is mounted. It is a required field rather
 * than an optional one on purpose: omitting it is a type error, which catches
 * an undeclared new endpoint at compile time instead of at review time.
 *
 * Every billable endpoint today is a `/__*` compiler endpoint, and every one
 * of those is still unmounted (see isUnmountedCompilerEndpoint). That means
 * the "a billable route is wrapped in requireBudget" property is not yet
 * observable on the live table — the set is empty, and a test asserting it
 * would pass without checking anything. What IS asserted here is the exclusion
 * itself: the moment 4c mounts these, the exclusion test fails and forces the
 * enforcement test to be written against real routes. Same mechanism 4a used
 * for the authorization rule.
 */
import type { ProjectIdSource } from "./require-project.ts";
import type { Route } from "./router.ts";

const BY_QUERY: ProjectIdSource = { from: "query", name: "project" };

export const PROJECT_SCOPED_ENDPOINTS: ReadonlyArray<{
  method: Route["method"];
  path: string;
  idFrom: ProjectIdSource;
  billable: boolean;
}> = [
  { method: "GET", path: "/api/projects/:id", idFrom: { from: "param", name: "id" }, billable: false },
  { method: "PUT", path: "/__overrides/:slug", idFrom: BY_QUERY, billable: false },
  { method: "GET", path: "/__overrides/:slug", idFrom: BY_QUERY, billable: false },
  { method: "GET", path: "/__overrides-history", idFrom: BY_QUERY, billable: false },
  { method: "PUT", path: "/__overrides-history", idFrom: BY_QUERY, billable: false },
  { method: "POST", path: "/__regen", idFrom: BY_QUERY, billable: true },
  { method: "POST", path: "/__regen-page", idFrom: BY_QUERY, billable: true },
  { method: "POST", path: "/__regen-revert", idFrom: BY_QUERY, billable: false },
  { method: "POST", path: "/__add-section", idFrom: BY_QUERY, billable: true },
  { method: "POST", path: "/__edit-prompt", idFrom: BY_QUERY, billable: true },
  { method: "POST", path: "/__export", idFrom: BY_QUERY, billable: false },
  { method: "GET", path: "/__export-download", idFrom: BY_QUERY, billable: false },
  { method: "GET", path: "/__plan", idFrom: BY_QUERY, billable: false },
  { method: "POST", path: "/__plan/section-brief", idFrom: BY_QUERY, billable: false },
  { method: "POST", path: "/__plan/approve", idFrom: BY_QUERY, billable: false },
];

/**
 * Project-independent, so a session is the whole rule. Listed rather than
 * implied, so "no project id" is a stated decision per endpoint and the
 * authorization test can assert these are NOT project-scoped.
 */
export const SESSION_ONLY_ENDPOINTS: ReadonlyArray<{ method: Route["method"]; path: string; billable: boolean }> = [
  { method: "GET", path: "/__archetypes", billable: false },
  { method: "GET", path: "/api/projects", billable: false },
  { method: "GET", path: "/api/me", billable: false },
  { method: "GET", path: "/api/key", billable: false },
  { method: "PUT", path: "/api/key", billable: false },
  { method: "DELETE", path: "/api/key", billable: false },
];

/**
 * Reachable with no session at all. Listed for the same reason as
 * SESSION_ONLY_ENDPOINTS: without an explicit third list, these two endpoints
 * belonged to neither list, and the bidirectional partition test
 * (project-registry.test.ts) could not be written at all — there was no
 * complete set of lists to check buildRoutes's output against.
 */
export const UNAUTHENTICATED_ENDPOINTS: ReadonlyArray<{ method: Route["method"]; path: string }> = [
  { method: "POST", path: "/api/login" },
  { method: "POST", path: "/api/logout" },
];

/**
 * Every `/__*` path above is a compiler-owned handler (regen-api, export-api,
 * plan-api, preview.ts) declared here so the authorization rule exists before
 * the endpoint is reachable, but not yet mounted on the hosted composition
 * root (compose.ts) — that needs 4c's preview pool, which is what turns a
 * projectId into a running preview process to route to. Until then these
 * entries are correct but unreachable, which is the safe direction to be
 * wrong in.
 *
 * This predicate is what lets the bidirectional test assert agreement with
 * the LIVE route table for everything that IS mounted today, while still
 * keeping every declared endpoint in exactly one of the three lists above. An
 * explicit, commented function rather than an inline filter, so a reader —
 * and the "excluded set is exactly this" test in project-registry.test.ts —
 * can see the exclusion instead of the check quietly discarding entries.
 */
export function isUnmountedCompilerEndpoint(path: string): boolean {
  return path.startsWith("/__");
}
