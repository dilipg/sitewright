/**
 * Ending a session — the counterpart to `LoginScreen`'s `submitLogin`.
 *
 * FIX ROUND B, R-6. `POST /api/logout` has existed since slice 2 (it revokes the
 * session row AND clears the cookie) and nothing in `editor/src` had ever called
 * it. The branch that added the login screen and the "Signed in as …" line
 * therefore shipped a session a user could start from the UI and not end from
 * it, which is precisely the case that line exists for: a shared machine.
 *
 * Its own module rather than a function inside the component, for the reason
 * `submitLogin` and `session-fetch.ts` already established: this workspace has no
 * React testing library and may not add one ("no new runtime dependencies"), so
 * anything living in a component body is untestable by construction. What can be
 * wrong here in a way that matters — which URL, which method, and whether a
 * FAILED sign-out is reported as a success — is all in this function.
 *
 * NOT `sessionAwareFetch`, deliberately, and the same reasoning `submitLogin`
 * records for itself: that layer turns every 401 into `SessionExpiredError`,
 * which the app renders as "Your session expired — sign in again." On a sign-out
 * request a 401 means the session was already gone, i.e. the user is already
 * where they asked to be — reporting an expiry there would be noise about the
 * one outcome that needs no explanation.
 */
import { logoutUrl } from "./backend";

export interface SubmitLogoutOptions {
  /** Test seam only; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolves only once the server has actually revoked the session.
 *
 * THROWS on anything else, and that is the load-bearing half: the whole point of
 * a sign-out on a shared machine is that the session is really gone, so a
 * network failure or a 500 must NOT be smoothed into "signed out" and shown a
 * login screen while the cookie still works. That is the same class of lie as
 * the autosave "Saved" on a 401 — a UI stating an outcome the server never
 * confirmed.
 *
 * A 401/403 is treated as SUCCESS, not failure: the server answers 200 for
 * "already logged out" (auth-routes.ts says so explicitly), and any other
 * not-authenticated answer means the same thing — there is no session left to
 * end. Both reach the user's goal, so both resolve.
 *
 * No body is read at all. There is nothing in it a user could act on, and
 * `router.ts`'s 4xx/5xx shapes are already covered by the status.
 */
export async function submitLogout(options: SubmitLogoutOptions = {}): Promise<void> {
  // Wrapped rather than aliased: a bare `const f = fetch; f(...)` invokes the
  // global with the wrong receiver and throws "Illegal invocation" in a browser.
  // (`submitLogin` carries the identical note, having hit it.)
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const response = await doFetch(logoutUrl(), {
    method: "POST",
    // Same-origin is already the default; stated explicitly because the whole
    // hosted design depends on this request CARRYING the session cookie (one
    // origin, via the Vite proxy) — without it the server has no session to
    // revoke and would cheerfully answer 200 having revoked nothing.
    credentials: "same-origin",
  });
  if (response.ok || response.status === 401 || response.status === 403) return;
  throw new Error(
    `Sign-out failed (HTTP ${String(response.status)}). You are still signed in on this machine.`,
  );
}
