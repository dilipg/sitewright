import { describe, expect, it } from "vitest";
import {
  backend,
  createBackend,
  editorUrlForProject,
  encodePathSegment,
  generateUrl,
  hostedMode,
  isHostedMode,
  jobProgressUrl,
  jobResumeUrl,
  jobUrl,
  loginUrl,
  meUrl,
  neutralizeDotSegments,
  projectsUrl,
  resolveMode,
} from "./backend";

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

/**
 * TASK 2 — hosted-shell mode, which is a DIFFERENT question from
 * `resolveMode`'s and must stay one.
 *
 * `resolveMode` answers "whose URLs do I build?", and only `?project=<id>` can
 * answer that. `isHostedMode` answers "am I talking to the hosted server at
 * all?", which has to be answerable before any project exists — a tester
 * following the README opens a bare `/` and must land on the login screen.
 */
describe("isHostedMode", () => {
  it("a bare URL with the flag unset is LOCAL — the state every existing test runs in", () => {
    // This is the assertion that makes local mode structural. Playwright's
    // webServer runs the plain `dev` script (never `.env.hosted`), so the flag
    // is absent for the entire milestone-7 suite and every one of its bare-`/`
    // navigations lands here.
    expect(isHostedMode("", undefined)).toBe(false);
    expect(isHostedMode("?preview=http://localhost:9999", undefined)).toBe(false);
  });

  it("VITE_WEBGEN_HOSTED=1 selects hosted mode with no ?project= at all", () => {
    // The whole point: a tester's very first page load has no project yet.
    expect(isHostedMode("", "1")).toBe(true);
  });

  it("only the exact string \"1\" turns it on", () => {
    // "0" and "false" are non-empty strings, and every non-empty string is
    // truthy — an operator who writes either means OFF, and reading them as ON
    // would drop a tester into hosted mode with no way back to local.
    for (const flag of ["0", "false", "", "yes", "true", "2"]) {
      expect(isHostedMode("", flag)).toBe(false);
    }
  });

  it("?project=<id> still selects hosted mode on its own, so every existing hosted URL is unchanged", () => {
    expect(isHostedMode("?project=proj-1", undefined)).toBe(true);
  });

  it("agrees with resolveMode about what counts as a project", () => {
    // The two read `?project=` through one shared helper precisely so they
    // cannot drift: an empty `?project=` is "no project" to both.
    for (const search of ["", "?project=", "?project=proj-1", "?preview=http://x"]) {
      const hostedByResolve = resolveMode(search, EDITOR_ORIGIN).kind === "hosted";
      expect(isHostedMode(search, undefined)).toBe(hostedByResolve);
    }
  });
});

describe("session-scoped URLs (no ?project=)", () => {
  it("login and me are relative, same-origin paths", () => {
    // Same-origin is what keeps the session cookie flowing under
    // `SameSite=Lax` with no CORS: the Vite dev server proxies `/api` to the
    // hosted server, so the browser only ever sees one origin.
    expect(loginUrl()).toBe("/api/login");
    expect(meUrl()).toBe("/api/me");
  });

  it("neither carries a project id — both routes are session-only on the server", () => {
    expect(loginUrl()).not.toContain("project=");
    expect(meUrl()).not.toContain("project=");
  });

  it("TASK 3: the project list and generate are session-only too", () => {
    // `GET /api/projects` answers the CALLER's own projects (scoped by the
    // server's SQL, not by a parameter), and `POST /api/generate` is the one
    // route that CREATES a project — "which project?" is not a question
    // either could answer.
    expect(projectsUrl()).toBe("/api/projects");
    expect(generateUrl()).toBe("/api/generate");
    expect(projectsUrl()).not.toContain("project=");
    expect(generateUrl()).not.toContain("project=");
  });

  it("TASK 4: the three job endpoints are session-only and name the job in the path", () => {
    // A job belongs to the USER who queued it, not to a project — a generate
    // job's `project_id` is `ON DELETE SET NULL`, so a project-scoped check
    // would have nothing to compare for exactly the jobs most worth looking up.
    expect(jobUrl("j1")).toBe("/api/jobs/j1");
    expect(jobProgressUrl("j1")).toBe("/api/jobs/j1/progress");
    expect(jobResumeUrl("j1")).toBe("/api/jobs/j1/resume");
    for (const url of [jobUrl("j1"), jobProgressUrl("j1"), jobResumeUrl("j1")]) {
      expect(url).not.toContain("project=");
    }
  });

  it("TASK 4: a job id of '..' cannot walk out of /api/jobs/ into another endpoint", () => {
    // THE FIFTH `..`. This codebase has shipped four at four layers, and
    // CLAUDE.md's standing instruction is to assume the next one exists. This
    // is a genuine candidate rather than a theoretical one: the job id reaching
    // these paths now comes from `localStorage` as well as from a 202 body, and
    // localStorage is writable by any script on this origin. `fetch()` resolves
    // a relative URL against the document and normalizes dot segments exactly
    // as the URL parser does, INCLUDING their percent-encoded spellings.
    for (const evil of ["../..", "..%2f..", "..", "%2e%2e/%2e%2e"]) {
      const resolved = new URL(jobUrl(evil), "http://localhost:5173/");
      expect(resolved.pathname.startsWith("/api/jobs/"), evil).toBe(true);
      expect(resolved.pathname, evil).not.toBe("/api/");
      const progress = new URL(jobProgressUrl(evil), "http://localhost:5173/");
      expect(progress.pathname.startsWith("/api/jobs/"), evil).toBe(true);
    }
  });

  it("TASK 4: a real job id (a v4 UUID) round-trips unchanged", () => {
    // The escaping must not corrupt the value it protects: every real job id is
    // a `randomUUID()`, which contains no character `encodePathSegment` touches.
    const id = "ed1b5088-eebf-44c9-967c-294ddc3f9705";
    expect(jobUrl(id)).toBe(`/api/jobs/${id}`);
  });
});

/**
 * TASK 3 — the editor's own URL for a chosen project, and the one place a
 * project id supplied by the SERVER re-enters this app.
 */
describe("editorUrlForProject", () => {
  it("sets ?project=<id> on the current URL", () => {
    expect(editorUrlForProject("proj-1", "http://localhost:5173/")).toBe(
      "http://localhost:5173/?project=proj-1",
    );
  });

  it("replaces an existing ?project= rather than appending a second one", () => {
    // Two `project` values would make `URLSearchParams.get` (and therefore
    // `resolveMode`) pick the first — i.e. the project the user just navigated
    // AWAY from — while the URL bar showed both.
    const url = new URL(editorUrlForProject("proj-2", "http://localhost:5173/?project=proj-1"));
    expect(url.searchParams.getAll("project")).toEqual(["proj-2"]);
  });

  it("keeps every other query parameter the URL already carried", () => {
    const url = new URL(
      editorUrlForProject("proj-1", "http://localhost:5173/?preview=http%3A%2F%2Fx&debug=1"),
    );
    expect(url.searchParams.get("preview")).toBe("http://x");
    expect(url.searchParams.get("debug")).toBe("1");
  });

  it("round-trips through resolveMode — the id that goes in is the id that comes out", () => {
    // The property that actually matters: this is the ONLY handoff between
    // the picker and the mode resolver, and a mismatch would open the wrong
    // project (or none) with no error anywhere.
    for (const id of ["proj-1", "3f8c1a54-0000-4000-8000-000000000001", "a b", "a&b=c", "a/b", "a?b"]) {
      const href = editorUrlForProject(id, "http://localhost:5173/");
      const mode = resolveMode(new URL(href).search, EDITOR_ORIGIN);
      expect(mode).toEqual({ kind: "hosted", projectId: id, origin: EDITOR_ORIGIN });
    }
  });

  it("does NOT apply previewUrl's double-escape — a query value is not a path segment", () => {
    // `encodePathSegment` exists because the WHATWG parser normalizes
    // `%2e`/`%2e%2e` dot SEGMENTS away, so a path needs `%2E` escaped a
    // second time (`%252E`). A query VALUE is subject to no such step:
    // `URLSearchParams` encodes once and `resolveMode` decodes once. Running
    // the double-escape here would not be extra safety, it would corrupt the
    // id into one no project has — which is what this asserts.
    const href = editorUrlForProject("a.b..c", "http://localhost:5173/");
    expect(new URL(href).searchParams.get("project")).toBe("a.b..c");
    expect(href).not.toContain("%252E");
  });

  it("a '..' id cannot climb the path, because it never reaches the path at all", () => {
    const href = editorUrlForProject("../../api/key", "http://localhost:5173/editor/");
    const url = new URL(href);
    expect(url.pathname).toBe("/editor/");
    expect(url.searchParams.get("project")).toBe("../../api/key");
  });
});

describe("the default export singleton", () => {
  it("hostedMode is false in a windowless, flag-less environment", () => {
    // The structural guarantee for local mode, asserted on the real singleton
    // rather than inferred from `isHostedMode`: `import.meta.env.
    // VITE_WEBGEN_HOSTED` is a build-time substitution, and neither vitest nor
    // Playwright's webServer loads `.env.hosted`, so nothing has to remember
    // to unset anything.
    expect(hostedMode).toBe(false);
  });

  it("resolves to local mode when imported with no window (this test file's own environment)", () => {
    // vitest.config.ts runs src/**/*.test.ts in Node, not jsdom (matching
    // App.test.ts's own "windowless environment" guard comment) -- so the
    // module-level `backend` singleton must have taken the `typeof window
    // === "undefined"` branch, exactly as `PREVIEW_URL` always did.
    expect(backend.mode).toBe("local");
    expect(backend.apiUrl("/__regen")).toBe("http://localhost:5273/__regen");
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING E — the PATH half of the traversal hazard this
 * module already defended the project id against.
 *
 * `previewUrl`'s `path` and the `route.slug` in `/__overrides/<slug>` are both
 * MODEL-GENERATED (`lib/canvas.ts` reads them off manifest nodes), and both
 * were interpolated raw. `new URL("/__overrides/../../api/key", origin)`
 * normalizes to `/api/key`; an iframe `src` and a plain `fetch()` apply the
 * identical normalization. Three `..` defects at three layers have now come out
 * of this codebase, so this closes the fourth instance rather than reasoning
 * about whether it is currently reachable.
 */
describe("neutralizeDotSegments (finding E)", () => {
  it("leaves a real path completely untouched, dots and all", () => {
    // The reason a blanket encodePathSegment over every segment is WRONG:
    // legitimate paths are full of dots.
    expect(neutralizeDotSegments("/manifest.json")).toBe("/manifest.json");
    expect(neutralizeDotSegments("/src/tokens/tokens.json")).toBe("/src/tokens/tokens.json");
    expect(neutralizeDotSegments("/")).toBe("/");
    expect(neutralizeDotSegments("/pricing")).toBe("/pricing");
    expect(neutralizeDotSegments("/pricing?regen=123")).toBe("/pricing?regen=123");
    // A sibling-looking name that merely BEGINS with dots is not a traversal.
    expect(neutralizeDotSegments("/..foo/bar")).toBe("/..foo/bar");
  });

  it("stops a traversal from climbing out of the project prefix", () => {
    const built = `/preview/abc${neutralizeDotSegments("/../../api/key")}`;
    expect(new URL(built, "http://editor.test/").pathname).toBe("/preview/abc/%252E%252E/%252E%252E/api/key");
  });

  it("stops the percent-encoded spelling too", () => {
    // The WHATWG parser treats %2e/%2E as equivalent to a literal dot for
    // dot-segment detection, so matching only the literal forms would leave
    // the encoded bypass wide open.
    for (const encoded of ["/%2e%2e/api/key", "/%2E%2E/api/key", "/%2e./api/key"]) {
      const built = `/preview/abc${neutralizeDotSegments(encoded)}`;
      expect(new URL(built, "http://editor.test/").pathname.startsWith("/preview/abc/")).toBe(true);
    }
  });

  it("does not rewrite inside a query string, where a dot segment means nothing", () => {
    expect(neutralizeDotSegments("/pricing?to=../x")).toBe("/pricing?to=../x");
  });
});

describe("previewUrl and the override URL both escape their model-generated part (finding E)", () => {
  it("previewUrl: a route path of '../../api/key' cannot climb out of /preview/<id>/", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "proj-1", origin: EDITOR_ORIGIN });
    const resolved = new URL(hosted.previewUrl("/../../api/key"), `${EDITOR_ORIGIN}/`);
    expect(resolved.pathname.startsWith("/preview/proj-1/")).toBe(true);
    expect(resolved.pathname).not.toBe("/api/key");
  });

  it("previewUrl: an ordinary route path is byte-identical to what it was before the fix", () => {
    // Local mode must stay byte-identical, and hosted mode must not churn
    // every real URL to close a hazard no real value triggers.
    const hosted = createBackend({ kind: "hosted", projectId: "proj-1", origin: EDITOR_ORIGIN });
    expect(hosted.previewUrl("/")).toBe("/preview/proj-1/");
    expect(hosted.previewUrl("/manifest.json")).toBe("/preview/proj-1/manifest.json");
    expect(hosted.previewUrl("/pricing?regen=9")).toBe("/preview/proj-1/pricing?regen=9");
    const local = createBackend({ kind: "local", previewOrigin: "http://localhost:5273" });
    expect(local.previewUrl("/manifest.json")).toBe("http://localhost:5273/manifest.json");
  });

  it("encodePathSegment: a slug of '..' cannot turn /__overrides/<slug> into another endpoint", () => {
    const hosted = createBackend({ kind: "hosted", projectId: "proj-1", origin: EDITOR_ORIGIN });
    const built = hosted.apiUrl(`/__overrides/${encodePathSegment("../api/key")}`);
    expect(new URL(built).pathname).not.toBe("/api/key");
    expect(new URL(built).pathname.startsWith("/__overrides/")).toBe(true);
  });

  it("encodePathSegment: an ordinary slug round-trips unchanged", () => {
    for (const slug of ["home", "pricing", "about-us", "route_2"]) {
      expect(encodePathSegment(slug)).toBe(slug);
    }
  });
});
