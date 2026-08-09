/**
 * The editor's one HTTP entry point, and the only place a hosted session
 * expiry is recognised.
 *
 * Extracted from `App.tsx` (whole-branch review, FINDING B). It lived inside
 * the component, which meant it had no tests of its own: `App.test.ts` cannot
 * mount `App` (there is no React testing library in this workspace, and "no
 * new runtime dependencies" rules one out), so every property below was only
 * ever exercised indirectly through Playwright — against the LOCAL,
 * unauthenticated preview server, which never answers 401 at all. The one
 * failure mode these functions exist for was therefore untested by
 * construction. Here it is a plain module with a `fetchImpl` seam.
 *
 * Nothing about the behaviour changed in the move.
 */

/**
 * Thrown by `sessionAwareFetch` in place of ever letting a 401 reach
 * `enqueueAndPoll`'s own response handling (task-8 brief, hosted mode). A
 * hosted session can lapse mid-run -- a job runs for minutes, and a tab may
 * sit open far longer -- and a 401 must surface as ITS OWN honest state,
 * never as a generic job failure and never silently retried. Without this,
 * a 401 would land in one of two equally wrong places: at the INITIAL
 * enqueue POST, `enqueueAndPoll` treats any non-202 status as "the body IS
 * the outcome" (by design, for the local server's synchronous 200s and a
 * hosted refusal answered before a job exists), so a 401's `{error: "not
 * authenticated"}` body would be read as a normal outcome and reported
 * through whichever flow's own generic failure panel happened to be
 * asking; MID-POLL, a non-ok response already makes `enqueueAndPoll` reject
 * with a bare, unstructured Error, indistinguishable from a dead job row or
 * a transient 500. This class makes the one case that actually means
 * "your session expired" identifiable by TYPE rather than by parsing
 * either of those generic shapes.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

/**
 * Passed as `enqueueAndPoll`'s `fetchImpl` for every job-backed flow.
 * `enqueueAndPoll` uses the SAME fetch reference for both the initial
 * enqueue POST and every poll GET (jobs.ts's own `doFetch`), so wrapping it
 * here catches a 401 at either point with one function -- no change to
 * jobs.ts itself, which already exposes `fetchImpl` (today only documented
 * as a test seam) as exactly the injection point this needs. Never fires
 * against the local, unauthenticated preview server, which has no session
 * and never answers 401.
 */
export async function sessionAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) throw new SessionExpiredError();
  return response;
}

/**
 * `sessionAwareFetch` plus the two things every JSON read in this app needs
 * and `refreshManifest` was missing (whole-branch review, FINDING B): a
 * `.ok` check, and therefore never parsing an error body as if it were the
 * resource.
 *
 * The concrete bug: `refreshManifest` called bare `fetch` and read `.json()`
 * unconditionally. A hosted 401's body (`{error: "not authenticated"}`)
 * parses as JSON perfectly well, so `manifest.nodes` became `undefined`, and
 * render then evaluated `manifest?.nodes[selectedId]` — where the optional
 * chain short-circuits on `manifest`, which is NOT null, so `.nodes` is read
 * and indexed, throwing inside render with no error boundary anywhere above
 * it. Worse, `refreshManifest` is called AFTER a regen has already succeeded,
 * so the same 401 surfaced as `setRegen({phase: "failed"})` — reporting
 * failure for work that actually landed, the exact lie the `interrupted`
 * handling exists to prevent.
 *
 * A 401 throws `SessionExpiredError` (so callers can show the session banner
 * rather than a failure panel); any other non-2xx throws a plain `Error`
 * naming the status. Both are thrown BEFORE `.json()` is called, so a body
 * this app did not ask for is never parsed, let alone used.
 *
 * `fetchImpl` exists for tests only, and defaults to `sessionAwareFetch` —
 * the same seam-with-a-real-default shape `enqueueAndPoll` already uses.
 */
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof sessionAwareFetch = sessionAwareFetch,
): Promise<T> {
  const response = await fetchImpl(input, init);
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${String(response.status)}`);
  }
  return (await response.json()) as T;
}
