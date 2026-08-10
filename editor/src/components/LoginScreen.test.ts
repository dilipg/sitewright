import { describe, expect, it } from "vitest";
import { submitLogin } from "./LoginScreen";
import { SessionExpiredError } from "../lib/session-fetch";

/**
 * `.test.ts`, not `.test.tsx`, following `ExportPanel.test.ts`'s precedent:
 * `vitest.config.ts` includes `src/**\/*.test.{ts,tsx}`, and everything asserted
 * here is a plain async function with a `fetchImpl` seam — no component is
 * mounted, because this workspace has no React testing library and may not
 * add one ("no new runtime dependencies"). That constraint is exactly why
 * `submitLogin` is a separate exported function rather than a method inside
 * the form component: the half of this screen that can be wrong in a way
 * that matters (the request it builds, and the message it reports back) is
 * the half that is testable without a DOM.
 */

/** Records every `init` the function under test passes to `fetch`. */
function recordingFetch(response: () => Response): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  };
  return { calls, fetchImpl };
}

const OK_USER = () =>
  new Response(JSON.stringify({ id: "u1", email: "a@b.c" }), { status: 200 });

describe("submitLogin: the request", () => {
  it("submits as JSON, because a form-encoded login is refused by design", async () => {
    // `POST /api/login` requires `Content-Type: application/json` and answers
    // 400 without it (verified live). That is not a formality: `SameSite=Lax`
    // only guards requests that SEND the session cookie, and login is the one
    // request that SETS one — a cross-site HTML form can only ever submit
    // urlencoded/multipart/text-plain, so requiring JSON is what closes
    // login-CSRF. Sending the wrong content type here would not "just work
    // anyway"; it would be a 400 that looks like a credentials problem.
    const calls: RequestInit[] = [];
    const fetchImpl = async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ id: "u1", email: "a@b.c" }), { status: 200 });
    };
    await submitLogin("a@b.c", "pw", { fetchImpl });
    expect((calls[0]!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("POSTs the credentials as a JSON body to /api/login", async () => {
    const { calls, fetchImpl } = recordingFetch(OK_USER);
    await submitLogin("a@b.c", "pw", { fetchImpl });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe("/api/login");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "a@b.c", password: "pw" });
  });

  it("returns the authenticated account on success", async () => {
    const { fetchImpl } = recordingFetch(OK_USER);
    await expect(submitLogin("a@b.c", "pw", { fetchImpl })).resolves.toEqual({
      id: "u1",
      email: "a@b.c",
    });
  });
});

describe("submitLogin: the failure message", () => {
  it("reports a failed login without revealing which field was wrong", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid email or password" }), { status: 401 });
    await expect(submitLogin("a@b.c", "wrong", { fetchImpl })).rejects.toThrow(
      /invalid email or password/,
    );
  });

  it("surfaces the server's message VERBATIM — it never composes one of its own", async () => {
    // The uniformity of that message is a SERVER property: unknown email,
    // wrong password and disabled account deliberately answer identically, so
    // the form cannot be used to enumerate which addresses have accounts. The
    // client's only job is to not undo it. Asserting the exact string (rather
    // than a substring match) is what catches an "improvement" that appends a
    // hint, substitutes a friendlier phrasing, or branches on the status to
    // guess at a cause — every one of which re-opens the oracle.
    //
    // A DIFFERENT server message from the one above on purpose: a hardcoded
    // "invalid email or password" in the client would satisfy the test above
    // and fail this one.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "email and password are required" }), { status: 400 });
    await expect(submitLogin("", "", { fetchImpl })).rejects.toThrow(
      new Error("email and password are required"),
    );
  });

  it("falls back to a field-neutral message when the server sends no message at all", async () => {
    // A proxy error page, an empty body, a 502 from the Vite dev proxy: none
    // of these carry `{error}`, and the fallback must still name no field.
    const fetchImpl = async () => new Response("<html>502</html>", { status: 502 });
    let message = "";
    await submitLogin("a@b.c", "pw", { fetchImpl }).catch((error: unknown) => {
      message = (error as Error).message;
    });
    expect(message).toContain("502");
    expect(message).not.toMatch(/\b(email|password)\b.*\b(wrong|incorrect|unknown|not found)\b/i);
  });

  it("a 401 here is bad credentials, NOT an expired session", async () => {
    // `sessionAwareFetch` turns every 401 into `SessionExpiredError`, which
    // App.tsx renders as "Your session expired — sign in again." On the LOGIN
    // request that would be a lie with a loop in it: the user is already on
    // the login screen, and the real cause is a typo. So this one call
    // deliberately does NOT go through the session-aware layer.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid email or password" }), { status: 401 });
    const error = await submitLogin("a@b.c", "wrong", { fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
  });
});
