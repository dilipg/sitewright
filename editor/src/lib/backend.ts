/**
 * Owns every URL the editor constructs against a backend (slice 5's job
 * model made the hosted server real; task-8 brief: wire the editor to it).
 * One module, one responsibility — no `fetch` call anywhere in the app
 * builds a `/__*` or `/api/*` URL by hand.
 *
 * MODE SELECTION follows the existing `?preview=` convention: a
 * `?project=<id>` query parameter on the EDITOR's own URL selects HOSTED
 * mode. Absent, this is LOCAL mode, byte-identical to the `PREVIEW_URL`
 * constant this module replaces (App.tsx, pre-task-8): `?preview=<origin>`
 * or `http://localhost:5273`, no `?project=`, no proxy, no credentials.
 *
 * HOSTED mode's own shape is dictated by one constraint: the browser must
 * see ONE origin. The Vite dev server proxies `/api`, `/__*` and `/preview`
 * to the hosted server (editor/vite.config.ts), so every hosted URL this
 * module builds is same-origin — the session cookie flows under
 * `SameSite=Lax` with no CORS involved, and none of slice 2's CSRF posture
 * is loosened. Cross-origin was rejected for exactly that reason (it would
 * need `SameSite=None; Secure` + CORS).
 *
 * Every hosted `/__*` (and `/api/jobs/...`) endpoint is reached by
 * `apiUrl(path)`, which appends `?project=<id>` — the query param every
 * project-scoped route in `server/src/project-registry.ts` reads via
 * `BY_QUERY`. It deliberately returns an ABSOLUTE url (this origin +
 * path + query), not a bare path: `editor/src/lib/jobs.ts`'s
 * `enqueueAndPoll` derives its poll URL via `new URL("/api/jobs/" + id,
 * url)`, and the WHATWG `URL` constructor requires its `base` argument to
 * already be an absolute URL — a relative `apiUrl` result would make that
 * call throw "Invalid URL" on every single hosted job, not just misbehave.
 * (Verified empirically before relying on it — see task-8-report.md.) This
 * is also exactly why LOCAL mode's own URLs were always absolute
 * (`http://localhost:5273/...`): the same constraint always applied, it
 * just had nothing to trip over before hosted mode existed.
 *
 * The project's own served content (a route page, `/manifest.json`,
 * `/src/tokens/tokens.json`) is reached by `previewUrl(path)` instead, which
 * is proxied at `/preview/<projectId>/*` — the id lives in the PATH (the
 * pool's own `:projectId` route param), never the query, so no `?project=`
 * here. It stays relative in hosted mode: an iframe `src` and a plain
 * `fetch()` both resolve a relative URL against the current document
 * implicitly (unlike `new URL(url, base)`, which has no such fallback), so
 * there is no equivalent trap to guard against here.
 */

/** Prefixed onto every hosted `/__*`/`/api` URL's query string. Must match
 *  `server/src/project-registry.ts`'s `BY_QUERY` (`{ from: "query", name:
 *  "project" }`) — this is the one place that name is duplicated on the
 *  editor side, since the two packages share no types across the process
 *  boundary. */
const PROJECT_QUERY_PARAM = "project";

const DEFAULT_LOCAL_ORIGIN = "http://localhost:5273";

export type BackendMode =
  | { readonly kind: "local"; readonly previewOrigin: string }
  | { readonly kind: "hosted"; readonly projectId: string; readonly origin: string };

/**
 * Pure and side-effect-free on purpose: it takes the editor's own
 * `location.search` and `location.origin` as plain strings rather than
 * reading `window` itself, so a test can exercise both modes directly
 * without fighting ES module caching (the module-level `backend` singleton
 * below is computed exactly once at import time).
 *
 * KNOWN HAZARD (task-8 review, not fixed here — recorded for whoever builds
 * the hosted entry points next): an EMPTY `?project=` (present with no
 * value, `URLSearchParams.get` returns `""`) is treated as "no project" and
 * silently falls through to LOCAL mode, pointed at `http://localhost:5273`.
 * That is the right call for a bare editor URL with no `?project=` at all
 * (today's only real caller), but once something generates hosted links for
 * users, a malformed or truncated one (`?project=` with the id dropped)
 * will not error — it will quietly open an editor aimed at a local server
 * that does not exist in a hosted deployment, whose failure mode is the
 * exact silent-hang class of bug this task's bootstrap fix (App.tsx) exists
 * to prevent, just triggered a different way (no server at all to answer,
 * rather than a 401 from a real one). Neither `resolveMode` nor any caller
 * validates that a non-empty `project` value is actually a plausible id
 * (e.g. UUID-shaped) before committing to hosted mode.
 */
export function resolveMode(search: string, origin: string): BackendMode {
  const params = new URLSearchParams(search);
  const projectId = params.get("project");
  if (projectId !== null && projectId !== "") {
    return { kind: "hosted", projectId, origin };
  }
  return { kind: "local", previewOrigin: params.get("preview") ?? DEFAULT_LOCAL_ORIGIN };
}

export interface Backend {
  readonly mode: BackendMode["kind"];
  /** `undefined` in local mode — there is no project, only the fixed local
   *  preview server. */
  readonly projectId: string | undefined;
  /** A compiler `/__*` endpoint (or, for `enqueueAndPoll`'s own use, the
   *  base a job's poll URL is derived from). Local mode: `${previewOrigin}
   *  ${path}`, unchanged from `PREVIEW_URL`. Hosted mode: an absolute,
   *  same-origin URL with `?project=<id>` appended (after any query `path`
   *  already carries — none do today, but a malformed or malicious
   *  `path` must not be able to smuggle a second `project` value past
   *  this). */
  apiUrl(path: string): string;
  /** A page or static asset served by the PROJECT's own preview server (a
   *  route path, `/manifest.json`, `/src/tokens/tokens.json`). Local mode:
   *  `${previewOrigin}${path}`, unchanged. Hosted mode: `/preview/<id>
   *  ${path}` — see this module's header comment for why the id, not the
   *  path, is what gets defended against corruption here. */
  previewUrl(path: string): string;
}

/**
 * Escapes ONE path segment so it can never be read as a dot segment. Used for
 * the project id in `previewUrl`, and (whole-branch review, FINDING E) for the
 * route slug every `/__overrides/<slug>` URL carries — a slug is
 * `nodeId.split(".")[0]` of a MODEL-GENERATED node id (`lib/canvas.ts`), and
 * `apiUrl`'s own `new URL(path, origin)` normalizes `/__overrides/../api/key`
 * to `/api/key`.
 *
 * `encodeURIComponent` leaves `.` unescaped (it is in its own "unreserved"
 * set), so a project id of exactly `".."` survives it completely unchanged
 * — and naively re-escaping the dot AFTERWARDS (`.replace(/\./g, "%2E")`)
 * is still not enough on its own: the WHATWG URL spec's own dot-segment
 * detection treats the percent-encoded forms `%2e`/`%2e%2e` as EQUIVALENT
 * to a literal `.`/`..` (closing exactly this bypass at the parser level),
 * so an iframe `src` or `fetch()` resolving `/preview/%2E%2E/x` against the
 * document still collapses it to `/x`, exactly as it would the raw
 * `/preview/../x` (verified empirically — see task-8-report.md). What
 * defeats that: escape the dot to the literal text `%2E` FIRST, then run
 * the whole string through `encodeURIComponent` a second time so the `%`
 * that introduces itself becomes `%25` — the result (`%252E`) matches none
 * of the spec's recognized dot-segment forms at any single decode step. A
 * real project id (always a `randomUUID()`, server-side) never contains a
 * `.` at all, so this never changes what a legitimate id round-trips to.
 * `?`, `&`, and `/` need no such double pass — they are not in
 * `encodeURIComponent`'s unreserved set, so one pass already escapes them,
 * and none of them are subject to any decode-then-reinterpret step the way
 * a dot-segment is.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment.replace(/\./g, "%2E"));
}

/**
 * WHOLE-BRANCH REVIEW, FINDING E — the other half of the hazard the comment
 * above already describes.
 *
 * `previewUrl`'s own `projectId` was double-escaped against `..` from the day
 * it was written; the `path` it is concatenated with was left completely raw,
 * and its callers pass `route.path` — a MODEL-GENERATED value (`lib/canvas.ts`
 * reads it off a manifest node). `new URL("/preview/<id>/../../api/key",
 * origin)` normalizes to `/api/key`, and an iframe `src` or a plain `fetch()`
 * applies the identical normalization. This codebase has now produced three
 * `..` defects at three different layers, so the path half is closed too.
 *
 * A blanket `encodePathSegment` over every segment is WRONG here and was
 * tried first: `/manifest.json` would become `/manifest%252Ejson` and stop
 * resolving. A path legitimately contains dots; what it must not contain is a
 * dot SEGMENT. So only genuine `.`/`..` segments are rewritten, and every
 * other segment passes through byte-for-byte — which is what keeps LOCAL mode
 * and every real route path completely unchanged.
 *
 * Percent-encoded spellings are folded first because the WHATWG URL parser
 * treats `%2e`/`%2e%2e` as equivalent to `.`/`..` for dot-segment detection
 * (the same fact the comment above records for the project id), so matching
 * only the literal forms would leave the encoded bypass wide open.
 *
 * Total by construction: it never throws and never clamps. A traversal-shaped
 * route path yields a harmless 404 inside the project's own preview instead of
 * a request aimed at `/api/key` — and `previewUrl` is called from render
 * (`src={backend.previewUrl(route.path)}`), where a throw would take the whole
 * editor down with no error boundary to catch it.
 */
export function neutralizeDotSegments(path: string): string {
  // Split off the query/fragment: only the PATH portion is subject to
  // dot-segment normalization, and rewriting inside a query string would
  // corrupt a legitimate value.
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const rest = cut === -1 ? "" : path.slice(cut);
  const safe = pathname
    .split("/")
    .map((segment) => {
      const decoded = segment.replace(/%2e/gi, ".");
      // `%252E` is `%2E` with its own `%` escaped, which matches none of the
      // spec's recognized dot-segment forms at any single decode step.
      return decoded === "." || decoded === ".." ? decoded.replace(/\./g, "%252E") : segment;
    })
    .join("/");
  return `${safe}${rest}`;
}

export function createBackend(mode: BackendMode): Backend {
  if (mode.kind === "local") {
    return {
      mode: "local",
      projectId: undefined,
      // Byte-identical to the old `${PREVIEW_URL}${path}` template — no
      // change in behavior for the code path every existing test runs
      // against (compiler/scripts/preview.ts, unauthenticated and local).
      apiUrl: (path) => `${mode.previewOrigin}${path}`,
      previewUrl: (path) => `${mode.previewOrigin}${path}`,
    };
  }
  const { projectId, origin } = mode;
  return {
    mode: "hosted",
    projectId,
    apiUrl: (path) => {
      const url = new URL(path, origin);
      url.searchParams.set(PROJECT_QUERY_PARAM, projectId);
      return url.toString();
    },
    previewUrl: (path) => `/preview/${encodePathSegment(projectId)}${neutralizeDotSegments(path)}`,
  };
}

// guarded: unit tests import this module (transitively, via App.tsx) in a
// windowless environment — the same guard `PREVIEW_URL` carried before this
// module replaced it. Hosted mode is never resolved in that environment
// (there is no `window.location` to read `?project=` from), so `origin` is
// never needed there either.
export const backend: Backend = createBackend(
  typeof window === "undefined"
    ? { kind: "local", previewOrigin: DEFAULT_LOCAL_ORIGIN }
    : resolveMode(window.location.search, window.location.origin),
);
