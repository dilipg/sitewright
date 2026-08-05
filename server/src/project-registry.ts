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
 */
import type { ProjectIdSource } from "./require-project.ts";
import type { Route } from "./router.ts";

const BY_QUERY: ProjectIdSource = { from: "query", name: "project" };

export const PROJECT_SCOPED_ENDPOINTS: ReadonlyArray<{
  method: Route["method"];
  path: string;
  idFrom: ProjectIdSource;
}> = [
  { method: "GET", path: "/api/projects/:id", idFrom: { from: "param", name: "id" } },
  { method: "PUT", path: "/__overrides/:slug", idFrom: BY_QUERY },
  { method: "GET", path: "/__overrides/:slug", idFrom: BY_QUERY },
  { method: "GET", path: "/__overrides-history", idFrom: BY_QUERY },
  { method: "PUT", path: "/__overrides-history", idFrom: BY_QUERY },
  { method: "POST", path: "/__regen", idFrom: BY_QUERY },
  { method: "POST", path: "/__regen-page", idFrom: BY_QUERY },
  { method: "POST", path: "/__regen-revert", idFrom: BY_QUERY },
  { method: "POST", path: "/__add-section", idFrom: BY_QUERY },
  { method: "POST", path: "/__edit-prompt", idFrom: BY_QUERY },
  { method: "POST", path: "/__export", idFrom: BY_QUERY },
  { method: "GET", path: "/__export-download", idFrom: BY_QUERY },
  { method: "GET", path: "/__plan", idFrom: BY_QUERY },
  { method: "POST", path: "/__plan/section-brief", idFrom: BY_QUERY },
  { method: "POST", path: "/__plan/approve", idFrom: BY_QUERY },
];

/**
 * Project-independent, so a session is the whole rule. Listed rather than
 * implied, so "no project id" is a stated decision per endpoint and the
 * authorization test can assert these are NOT project-scoped.
 */
export const SESSION_ONLY_ENDPOINTS: ReadonlyArray<{ method: Route["method"]; path: string }> = [
  { method: "GET", path: "/__archetypes" },
  { method: "GET", path: "/api/projects" },
  { method: "GET", path: "/api/me" },
  { method: "GET", path: "/api/key" },
  { method: "PUT", path: "/api/key" },
  { method: "DELETE", path: "/api/key" },
];
