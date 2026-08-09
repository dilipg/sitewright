import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, SessionExpiredError, sessionAwareFetch } from "./session-fetch";

/** A Response-shaped double: `sessionAwareFetch` reads `.status`, `fetchJson` reads `.ok` and `.json()`. */
function response(status: number, body: unknown, onJson?: () => void): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => { onJson?.(); return body; },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionAwareFetch", () => {
  it("throws SessionExpiredError on 401, by TYPE — never a generic Error a caller has to string-match", async () => {
    vi.stubGlobal("fetch", async () => response(401, { error: "not authenticated" }));
    await expect(sessionAwareFetch("/whatever")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("returns any other response untouched, including a non-2xx one", async () => {
    const res = response(500, { error: "boom" });
    vi.stubGlobal("fetch", async () => res);
    await expect(sessionAwareFetch("/whatever")).resolves.toBe(res);
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING B. `refreshManifest` used bare `fetch` and read
 * `.json()` unconditionally, so a hosted 401's body — which parses as JSON
 * perfectly well — became the "manifest", `manifest.nodes` became `undefined`,
 * and render threw at `manifest?.nodes[selectedId]`. And because both regen
 * paths call it AFTER the job succeeded, the same 401 surfaced as a regen
 * FAILURE for work that had already landed.
 */
describe("fetchJson", () => {
  it("returns the parsed body on a 2xx", async () => {
    const fake = vi.fn(async () => response(200, { nodes: { "home.hero": {} } }));
    await expect(fetchJson("/manifest.json", undefined, fake)).resolves.toEqual({ nodes: { "home.hero": {} } });
  });

  it("throws SessionExpiredError on a 401 WITHOUT parsing the body", async () => {
    // The load-bearing half: a 401 body is valid JSON, so "it threw" is not
    // enough — the body must never be read at all, or a future refactor that
    // reads first and checks later reintroduces exactly this bug.
    let parsed = false;
    const fake = vi.fn(async () => {
      const res = response(401, { error: "not authenticated" }, () => { parsed = true; });
      if (res.status === 401) throw new SessionExpiredError();
      return res;
    });
    await expect(fetchJson("/manifest.json", undefined, fake)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(parsed).toBe(false);
  });

  it("throws a plain Error naming the status on any other non-2xx, WITHOUT parsing the body", async () => {
    let parsed = false;
    const fake = vi.fn(async () => response(500, { error: "boom" }, () => { parsed = true; }));
    const failure = await fetchJson("/manifest.json", undefined, fake).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SessionExpiredError);
    expect((failure as Error).message).toContain("500");
    expect(parsed).toBe(false);
  });

  it("passes its init through, so a caller's cache: no-store is not silently dropped", async () => {
    const fake = vi.fn(async () => response(200, {}));
    await fetchJson("/manifest.json", { cache: "no-store" }, fake);
    expect(fake).toHaveBeenCalledWith("/manifest.json", { cache: "no-store" });
  });

  it("defaults to sessionAwareFetch, so a caller that omits fetchImpl still gets 401 detection", async () => {
    vi.stubGlobal("fetch", async () => response(401, { error: "not authenticated" }));
    await expect(fetchJson("/manifest.json")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
