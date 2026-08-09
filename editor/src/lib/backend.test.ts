import { describe, expect, it } from "vitest";
import { backend, createBackend, resolveMode } from "./backend";

const LOCAL_ORIGIN = "http://localhost:5273";
const EDITOR_ORIGIN = "http://localhost:5174";

describe("resolveMode", () => {
  it("no query at all -> local mode, default preview origin", () => {
    expect(resolveMode("", EDITOR_ORIGIN)).toEqual({ kind: "local", previewOrigin: LOCAL_ORIGIN });
  });

  it("?preview=<origin> with no ?project= -> local mode at that origin (today's convention, unchanged)", () => {
    expect(resolveMode("?preview=http://localhost:9999", EDITOR_ORIGIN)).toEqual({
      kind: "local",
      previewOrigin: "http://localhost:9999",
    });
  });

  it("?project=<id> -> hosted mode, carrying the editor's own origin", () => {
    expect(resolveMode("?project=proj-1", EDITOR_ORIGIN)).toEqual({
      kind: "hosted",
      projectId: "proj-1",
      origin: EDITOR_ORIGIN,
    });
  });

  it("an empty ?project= (present but valueless) does not select hosted mode", () => {
    expect(resolveMode("?project=", EDITOR_ORIGIN).kind).toBe("local");
  });

  it("?project= together with ?preview= -> hosted wins (the newer, more specific signal)", () => {
    expect(resolveMode("?project=proj-1&preview=http://localhost:9999", EDITOR_ORIGIN)).toEqual({
      kind: "hosted",
      projectId: "proj-1",
      origin: EDITOR_ORIGIN,
    });
  });
});

describe("createBackend: local mode builds today's URLs exactly", () => {
  const local = createBackend({ kind: "local", previewOrigin: LOCAL_ORIGIN });

  it("apiUrl is exactly ${previewOrigin}${path}, no project param", () => {
    expect(local.apiUrl("/__regen")).toBe("http://localhost:5273/__regen");
    expect(local.apiUrl("/__overrides/home")).toBe("http://localhost:5273/__overrides/home");
  });

  it("previewUrl is exactly ${previewOrigin}${path}", () => {
    expect(local.previewUrl("/")).toBe("http://localhost:5273/");
    expect(local.previewUrl("/manifest.json")).toBe("http://localhost:5273/manifest.json");
    expect(local.previewUrl("/about?regen=123")).toBe("http://localhost:5273/about?regen=123");
  });

  it("carries no project id", () => {
    expect(local.projectId).toBeUndefined();
    expect(local.mode).toBe("local");
  });
});

describe("createBackend: hosted mode appends ?project= to every endpoint", () => {
  const hosted = createBackend({ kind: "hosted", projectId: "proj-42", origin: EDITOR_ORIGIN });

  it("a bare path gets ?project=<id> appended", () => {
    expect(hosted.apiUrl("/__regen")).toBe("http://localhost:5174/__regen?project=proj-42");
  });

  it("a path with its own segments still gets ?project= appended, not inserted mid-path", () => {
    expect(hosted.apiUrl("/__overrides/home")).toBe(
      "http://localhost:5174/__overrides/home?project=proj-42",
    );
  });

  it("every endpoint the editor calls carries it, not just one sampled path", () => {
    const paths = [
      "/__plan",
      "/__overrides-history",
      "/__edit-prompt",
      "/__archetypes",
      "/__add-section",
      "/__regen-page",
      "/__regen-revert",
      "/__plan/section-brief",
      "/__plan/approve",
      "/__export",
      "/__export-download",
    ];
    for (const path of paths) {
      const url = new URL(hosted.apiUrl(path));
      expect(url.searchParams.get("project")).toBe("proj-42");
      expect(url.pathname).toBe(path);
    }
  });

  it("the result is an ABSOLUTE, same-origin URL -- required by jobs.ts's enqueueAndPoll, which derives its poll URL via `new URL(pollPath, url)` and throws if `url` is not itself absolute", () => {
    const enqueueUrl = hosted.apiUrl("/__regen");
    expect(() => new URL(enqueueUrl)).not.toThrow(); // absolute on its own
    // the exact derivation enqueueAndPoll performs
    const pollUrl = new URL("/api/jobs/abc-123", enqueueUrl);
    expect(pollUrl.toString()).toBe("http://localhost:5174/api/jobs/abc-123");
  });

  it("carries the project id", () => {
    expect(hosted.projectId).toBe("proj-42");
    expect(hosted.mode).toBe("hosted");
  });
});

describe("createBackend: previewUrl is /preview/<id>/<route> in hosted mode", () => {
  const hosted = createBackend({ kind: "hosted", projectId: "proj-42", origin: EDITOR_ORIGIN });

  it("a route path", () => {
    expect(hosted.previewUrl("/")).toBe("/preview/proj-42/");
    expect(hosted.previewUrl("/about")).toBe("/preview/proj-42/about");
  });

  it("a static project asset", () => {
    expect(hosted.previewUrl("/manifest.json")).toBe("/preview/proj-42/manifest.json");
  });

  it("carries no ?project= query -- the id lives in the path, per the pool's own :projectId param", () => {
    expect(hosted.previewUrl("/about")).not.toContain("project=");
  });
});

describe("a malicious project id cannot corrupt the resulting URL", () => {
  it("apiUrl: a project id containing ?, &, or / stays a single, inert query VALUE", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "a?b&c/d", origin: EDITOR_ORIGIN });
    const url = new URL(hosted.apiUrl("/__regen"));
    // exactly one query param, and it round-trips to the original string
    expect([...url.searchParams.keys()]).toEqual(["project"]);
    expect(url.searchParams.get("project")).toBe("a?b&c/d");
    expect(url.pathname).toBe("/__regen");
  });

  it("previewUrl: a project id of '..' does not escape the /preview/ prefix via dot-segment normalization", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "..", origin: EDITOR_ORIGIN });
    const built = hosted.previewUrl("/manifest.json");
    // Resolve it exactly the way a browser resolves an iframe `src` or a
    // relative `fetch()` call -- against the current document. A naive
    // single-pass escape (encodeURIComponent + replacing "." with "%2E")
    // LOOKS safe as a string but still collapses here: the WHATWG URL
    // spec's own dot-segment detection treats "%2e"/"%2e%2e" as equivalent
    // to a literal "."/".." and normalizes them away during resolution --
    // this assertion is what catches that if the double-escape above is
    // ever "simplified" back down to one pass.
    const resolved = new URL(built, `${EDITOR_ORIGIN}/`);
    expect(resolved.pathname.startsWith("/preview/")).toBe(true);
    expect(resolved.pathname).not.toBe("/manifest.json");
  });

  it("previewUrl: a project id of '../../api/key' cannot climb out of /preview/ either", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "../../api/key", origin: EDITOR_ORIGIN });
    const built = hosted.previewUrl("/manifest.json");
    const resolved = new URL(built, `${EDITOR_ORIGIN}/`);
    expect(resolved.pathname.startsWith("/preview/")).toBe(true);
  });

  it("previewUrl: a project id containing ? or & does not introduce a query string", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "a?b&c=d", origin: EDITOR_ORIGIN });
    const built = hosted.previewUrl("/manifest.json");
    const resolved = new URL(built, `${EDITOR_ORIGIN}/`);
    expect(resolved.search).toBe("");
    expect(resolved.pathname.startsWith("/preview/")).toBe(true);
  });
});

describe("the default export singleton", () => {
  it("resolves to local mode when imported with no window (this test file's own environment)", () => {
    // vitest.config.ts runs src/**/*.test.ts in Node, not jsdom (matching
    // App.test.ts's own "windowless environment" guard comment) -- so the
    // module-level `backend` singleton must have taken the `typeof window
    // === "undefined"` branch, exactly as `PREVIEW_URL` always did.
    expect(backend.mode).toBe("local");
    expect(backend.apiUrl("/__regen")).toBe("http://localhost:5273/__regen");
  });
});
