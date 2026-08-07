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
 * Every billable endpoint is a `/__*` compiler endpoint, mounted by
 * `compiler-routes.ts` — which derives its route list from this registry
 * rather than retyping it, and wraps a `billable` entry's inner handler in
 * `requireBudget` in addition to `requireProject`. `project-registry.test.ts`'s
 * "billable endpoints" block used to assert an exclusion (no billable route
 * mounted at all) as a placeholder tripwire, precisely because it could not
 * yet assert the real property. Now that mounting is real, it asserts that
 * property directly: a real over-cap request against every billable endpoint
 * in the LIVE, composed route table answers 402 — table-driven over this
 * list, so a future billable endpoint added without a budget gate fails it.
 *
 * `async` (slice 5, the job model) marks an endpoint that ENQUEUES rather
 * than performs its work inline — the six job kinds (`generate` plus the five
 * proxied ones: `regen`, `regen-page`, `add-section`, `edit-prompt`,
 * `export`) answer 202 with a job id instead of the eventual result.
 * Required for the identical reason `billable` is: a future long-running
 * endpoint added without deciding this is a compile error, not a reviewer's
 * job to notice. The two flags are INDEPENDENT — `/__export` is `async` but
 * not `billable` (a production build spends no model money, so refusing it
 * over the spend cap would strand a user's already-generated site behind a
 * bill, same reasoning as `/__export-download`'s existing `billable: false`),
 * and every OTHER `billable` endpoint here also happens to be `async` (all
 * four spawn a subprocess), but that is a fact about today's six kinds, not a
 * rule this type enforces.
 */
import type { ProjectIdSource } from "./require-project.ts";
import type { Route } from "./router.ts";

/**
 * Exported (not module-private) so a hand-declared route that is not itself
 * derived from this registry's own loop — `job-routes.ts`'s `GET /api/jobs`,
 * which is `SESSION_ONLY_ENDPOINTS`-shaped rather than looped over
 * `PROJECT_SCOPED_ENDPOINTS` the way `compiler-routes.ts`'s entries are —
 * can still use the SAME id-source object the registry's own `GET /api/jobs`
 * entry below declares, rather than a second, hand-copied literal. Two
 * copies of `{ from: "query", name: "project" }` would type-check
 * identically while drifting silently on the query param's NAME (a typo in
 * one, not the other) — this registry is meant to be the single source of
 * authorization truth, and the partition test only compares method+path, so
 * a param-name drift between the two would go untested.
 */
export const BY_QUERY: ProjectIdSource = { from: "query", name: "project" };

export const PROJECT_SCOPED_ENDPOINTS: ReadonlyArray<{
  method: Route["method"];
  path: string;
  idFrom: ProjectIdSource;
  billable: boolean;
  async: boolean;
}> = [
  { method: "GET", path: "/api/projects/:id", idFrom: { from: "param", name: "id" }, billable: false, async: false },
  // Slice 5: a project's own recent jobs (regen/export/etc. history) —
  // read-only, spends nothing, and completes immediately (it queries the
  // `job` table, never touches a preview child), so both flags are false.
  { method: "GET", path: "/api/jobs", idFrom: BY_QUERY, billable: false, async: false },
  { method: "PUT", path: "/__overrides/:slug", idFrom: BY_QUERY, billable: false, async: false },
  { method: "GET", path: "/__overrides/:slug", idFrom: BY_QUERY, billable: false, async: false },
  { method: "GET", path: "/__overrides-history", idFrom: BY_QUERY, billable: false, async: false },
  { method: "PUT", path: "/__overrides-history", idFrom: BY_QUERY, billable: false, async: false },
  { method: "POST", path: "/__regen", idFrom: BY_QUERY, billable: true, async: true },
  { method: "POST", path: "/__regen-page", idFrom: BY_QUERY, billable: true, async: true },
  { method: "POST", path: "/__regen-revert", idFrom: BY_QUERY, billable: false, async: false },
  { method: "POST", path: "/__add-section", idFrom: BY_QUERY, billable: true, async: true },
  { method: "POST", path: "/__edit-prompt", idFrom: BY_QUERY, billable: true, async: true },
  // Spec deviation, recorded in docs/decisions.md (2026-08-06): the spec
  // calls this "project-independent, needs only a session," but it is
  // served by `regenApiPlugin` (compiler/src/regen-api.ts), which exists
  // only INSIDE a project's own preview child — there is no session-only
  // process to ask. Resolved as project-scoped, `idFrom: BY_QUERY`, rather
  // than either alternative: routing to an arbitrary already-running child
  // depends on unrelated state (whichever project happens to be warm), and
  // giving the server its own copy of the catalog duplicates data the
  // compiler already owns (`archetypeCatalog` reads the orchestrator's own
  // catalog module, which decides which archetypes actually have prompt
  // templates — a second copy would drift the moment one is added).
  { method: "GET", path: "/__archetypes", idFrom: BY_QUERY, billable: false, async: false },
  // Slice 5: a production build takes several minutes, so this becomes a job
  // too — but it spends no model money (the build is deterministic), so
  // `billable` stays false for the same reason /__export-download's already
  // is: refusing an export over the spend cap would strand a user's already-
  // generated site behind a bill.
  { method: "POST", path: "/__export", idFrom: BY_QUERY, billable: false, async: true },
  { method: "GET", path: "/__export-download", idFrom: BY_QUERY, billable: false, async: false },
  { method: "GET", path: "/__plan", idFrom: BY_QUERY, billable: false, async: false },
  { method: "POST", path: "/__plan/section-brief", idFrom: BY_QUERY, billable: false, async: false },
  { method: "POST", path: "/__plan/approve", idFrom: BY_QUERY, billable: false, async: false },
  // Task 4: serves the project's own Vite dev server through the pool +
  // proxy. Project-scoped (the id is the route's own :projectId segment,
  // not a query param, since it is the FIRST endpoint reached before any
  // asset path is even known) and not billable — serving files spends
  // nothing; the model call already happened when the project was generated.
  { method: "GET", path: "/preview/:projectId/*", idFrom: { from: "param", name: "projectId" }, billable: false, async: false },
];

/**
 * Project-independent, so a session is the whole rule. Listed rather than
 * implied, so "no project id" is a stated decision per endpoint and the
 * authorization test can assert these are NOT project-scoped.
 *
 * `GET /api/jobs/:id` belongs here rather than in `PROJECT_SCOPED_ENDPOINTS`
 * even though its path carries an id and its handler DOES check ownership:
 * this list's actual meaning is "not gated through `requireProject`'s
 * project-id-based rule," and a job is owner-checked on its own `user_id`
 * instead (job-routes.ts) — a generation job's `project_id` can go NULL
 * (`ON DELETE SET NULL`) if its project is later deleted, so a `requireProject`
 * -shaped check would have nothing left to compare against for exactly the
 * jobs most worth still being able to look up. `SESSION_ONLY_ENDPOINTS` is
 * the correct bucket for "a session is necessary, but the per-resource check
 * is not `requireProject`'s," not a claim that no ownership check happens at
 * all.
 */
export const SESSION_ONLY_ENDPOINTS: ReadonlyArray<{ method: Route["method"]; path: string; billable: boolean; async: boolean }> = [
  { method: "GET", path: "/api/projects", billable: false, async: false },
  { method: "GET", path: "/api/me", billable: false, async: false },
  { method: "GET", path: "/api/key", billable: false, async: false },
  { method: "PUT", path: "/api/key", billable: false, async: false },
  { method: "DELETE", path: "/api/key", billable: false, async: false },
  { method: "GET", path: "/api/jobs/:id", billable: false, async: false },
  // Slice 5's first web-triggered generation, and the endpoint
  // project-registry.test.ts's session-only-billable placeholder existed
  // for: no project exists yet when a generation starts (the project row is
  // created INSIDE this handler, before the job is enqueued), so this cannot
  // be project-scoped — but it starts the most expensive job kind of all
  // six, so `billable: true`.
  { method: "POST", path: "/api/generate", billable: true, async: true },
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
