/**
 * FIX ROUND B, R-6.
 *
 * `.test.ts`, never `.test.tsx` — `vitest.config.ts` once included
 * `src/**\/*.test.ts` only, so a `.test.tsx` file was silently skipped: coverage
 * that never runs, which no perturbation can detect.
 *
 * Nothing here mounts a component (no React testing library in this workspace,
 * and "no new runtime dependencies"). That is exactly why the request lives in
 * `lib/logout.ts` rather than inside the picker — and why the picker's own WIRING
 * is asserted separately, against its source, in `ProjectPicker.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { submitLogout } from "./logout";

function recordingFetch(respond: (url: string, init: RequestInit) => Response): {
  calls: Array<{ url: string; method: string; credentials?: RequestCredentials }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; method: string; credentials?: RequestCredentials }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      credentials: init?.credentials,
    });
    return respond(String(url), init ?? {});
  };
  return { calls, fetchImpl };
}

describe("submitLogout: the first caller POST /api/logout has ever had", () => {
  it("POSTs to /api/logout, exactly once, carrying the session cookie", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("{}", { status: 200 }));
    await submitLogout({ fetchImpl });

    expect(calls).toHaveLength(1);
    // The URL comes from `backend.ts`'s `logoutUrl()`; asserted as a literal here
    // so a change to that function cannot silently retarget the sign-out.
    expect(calls[0]!.url).toBe("/api/logout");
    // GET would be a no-op against a route table where the (method, path) pair IS
    // the allowlist — an unregistered method is unreachable, not merely unguarded.
    expect(calls[0]!.method).toBe("POST");
    // Without the cookie the server has no session to revoke and answers 200
    // having revoked NOTHING, which is the silent version of this whole bug.
    expect(calls[0]!.credentials).toBe("same-origin");
  });

  it("does NOT resolve when the server failed — a sign-out that did not happen must not report success", async () => {
    // The load-bearing case. Resolving here would show the login screen while
    // the cookie still works: the next person at a shared machine is one reload
    // away from the previous user's session. Same class of lie as the autosave
    // "Saved" on a 401.
    const { fetchImpl } = recordingFetch(() => new Response("boom", { status: 500 }));
    await expect(submitLogout({ fetchImpl })).rejects.toThrow(
      // Asserted in full: `toThrow(/failed/)` still passes if the message loses
      // the half that tells the user where they actually stand.
      "Sign-out failed (HTTP 500). You are still signed in on this machine.",
    );
  });

  it("rejects on a transport failure rather than swallowing it", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    }) as unknown as typeof fetch;
    await expect(submitLogout({ fetchImpl })).rejects.toThrow(/NetworkError/);
  });

  it("treats 'already logged out' as success — 200, 401 and 403 all resolve", async () => {
    // The server answers 200 for a logout with no session ("logging out when
    // already logged out is not an error", auth-routes.ts). A 401/403 means the
    // same thing: there is no session left to end, which IS the user's goal.
    for (const status of [200, 401, 403]) {
      const { fetchImpl } = recordingFetch(() => new Response("{}", { status }));
      await expect(submitLogout({ fetchImpl })).resolves.toBeUndefined();
    }
  });

  it("reads no response body at all", async () => {
    // Nothing in it is actionable, and a body-reading sign-out would fail on the
    // empty/non-JSON responses a proxy can return.
    let bodyRead = false;
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          bodyRead = true;
          return {};
        },
        text: async () => {
          bodyRead = true;
          return "";
        },
      }) as unknown as Response) as unknown as typeof fetch;
    await submitLogout({ fetchImpl });
    expect(bodyRead).toBe(false);
  });
});
