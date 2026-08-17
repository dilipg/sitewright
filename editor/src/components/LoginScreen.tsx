/**
 * The first caller `POST /api/login` has ever had.
 *
 * The route has existed since slice 2 and nothing in `editor/src` referenced
 * it — every project-scoped route composes over `requireSession`, so until
 * now a tester could not get past their first request from a browser. This is
 * the screen that closes that gap, and it is shown in HOSTED MODE ONLY
 * (`backend.ts`'s `hostedMode`): the local, unauthenticated preview server
 * has no session, never answers 401, and must keep behaving exactly as it
 * does today.
 *
 * THREE AFFORDANCES ARE DELIBERATELY ABSENT, and none of them is an
 * oversight to be helpfully filled in later:
 *
 * - **No sign-up link.** Account creation exists ONLY in
 *   `server/src/user-cli.ts`; no HTTP route creates a user, which is what
 *   makes invite-only a property of the code rather than a feature nobody got
 *   around to. A link would be a dead end pointing at a route that does not
 *   and must not exist.
 * - **No "create account" affordance**, for the same reason.
 * - **No password-reset link.** There is no email-based recovery anywhere in
 *   this system. The operator CLI resets a password; the README says so.
 *
 * `submitLogin` is exported separately from the component on purpose. This
 * workspace has no React testing library and may not add one ("no new runtime
 * dependencies"), so a function inside the component would be untestable by
 * construction — the same reasoning that pulled `session-fetch.ts` out of
 * `App.tsx`, and the same seam shape (`fetchImpl`, defaulted to the real one).
 */
import { useState } from "react";
import { loginUrl } from "../lib/backend";

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
}

export interface SubmitLoginOptions {
  /** Test seam only; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface LoginScreenProps {
  /** Called once the server has set a session cookie. */
  readonly onAuthenticated: () => void;
}

/**
 * Reads the server's own failure message and returns it UNCHANGED.
 *
 * The uniformity of that message across unknown-email / wrong-password /
 * disabled-account is a deliberate server property (`auth-routes.ts`'s single
 * `INVALID` constant, and the real argon2 verification that runs even when no
 * user matched, so the timing matches too): it is what stops the form being an
 * account-enumeration oracle. The client's only job is to not undo it — so
 * nothing here inspects the status to guess a cause, appends a hint, or
 * rewords anything. The fallback, for a response that carries no message at
 * all, names no field either.
 */
async function failureMessage(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy error page, an empty body, an upstream that died mid-response:
    // not JSON, and not a reason to throw a second error over the first.
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string" && error !== "") return error;
  return `Sign-in failed (HTTP ${String(response.status)}).`;
}

/**
 * `Content-Type: application/json` is REQUIRED and is not a formality: the
 * server answers 400 without it (`auth-routes.ts`'s `hasJsonContentType`).
 * `SameSite=Lax` only guards requests that SEND the session cookie, and login
 * is the one request that SETS one; a cross-site HTML form can submit only
 * `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
 * never JSON — so this header is what closes login-CSRF.
 *
 * Note what this does NOT use: `sessionAwareFetch`. That layer turns every
 * 401 into `SessionExpiredError`, which the app renders as "Your session
 * expired — sign in again." On the login request itself that would be a lie
 * with a loop in it: the user is already here, and a 401 means the
 * credentials were wrong.
 */
export async function submitLogin(
  email: string,
  password: string,
  options: SubmitLoginOptions = {},
): Promise<AuthenticatedUser> {
  // Wrapped rather than aliased: a bare `const f = fetch; f(...)` invokes the
  // global with the wrong receiver and throws "Illegal invocation" in a
  // browser.
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const response = await doFetch(loginUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Same-origin is already the default; stated explicitly because the whole
    // hosted design depends on this request's `Set-Cookie` being stored and
    // replayed by the browser (one origin, via the Vite proxy).
    credentials: "same-origin",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
  return (await response.json()) as AuthenticatedUser;
}

export default function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await submitLogin(email, password);
      onAuthenticated();
    } catch (caught) {
      // Verbatim, whatever it is — see `failureMessage`.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen" data-testid="login-screen">
      <form className="login-card" onSubmit={(event) => void onSubmit(event)}>
        <h1>Website Generator</h1>
        <p className="login-intro">Sign in to generate and edit sites.</p>

        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          data-testid="login-email"
          // `text`, NOT `email`, and this is load-bearing rather than sloppy.
          // The server's login treats this value as an OPAQUE IDENTIFIER: it
          // looks the string up verbatim, and `looksLikeEmail` is enforced only
          // in `server/src/user-cli.ts` — never in `createUser` and never in
          // `findUserByEmail`. So accounts whose name is not an email address
          // legitimately exist, and the local default account seeded by
          // `server/src/dev-admin.ts` is exactly one: it is literally `admin`.
          //
          // With `type="email"` the browser's own constraint validation refuses
          // to submit ("Please include an '@' in the email address"), so the
          // credential the SERVER CONSOLE just told the user to type could not
          // be typed here at all — a dead end with no server round trip, which
          // is why no API-level test could have caught it.
          //
          // A form must not impose a stricter rule than the system it submits
          // to. `inputMode` keeps the email keyboard on a phone and
          // `autoComplete="username"` keeps password managers working, so the
          // affordances survive without the false rejection.
          type="text"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          // App.tsx registers a window-level keydown handler (Esc, Ctrl+Z,
          // Ctrl+Y) whose effect is still mounted while this screen renders —
          // without this, Ctrl+Z in a credentials field would be swallowed by
          // the canvas's undo. Same guard PlanApproval's textarea carries.
          onKeyDown={(event) => event.stopPropagation()}
        />

        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />

        {error !== undefined && (
          <p className="login-error" data-testid="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" data-testid="login-submit" className="login-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {/* Not a sign-up prompt — the opposite. Stating plainly that there is
            no self-service path stops a tester hunting for a link that this
            system structurally does not have, without hinting at anything
            about any particular address. */}
        <p className="login-footnote">
          Accounts are created by the operator CLI (<code>server/scripts/user.ts</code>). There is no
          sign-up and no password reset by email.
        </p>
      </form>
    </div>
  );
}
