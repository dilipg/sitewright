/**
 * Why a project could not be opened — asked of the SERVER instead of guessed.
 *
 * THE GAP THIS CLOSES, from a real tester session. A generation failed at gate
 * 1 with a diagnosis so precise it named the file, the line, the unresolved
 * specifier and the TS code:
 *
 *     failed stage: fanout
 *     gate 1 imports-resolve: unresolved-import
 *     src/pages/home/index.tsx:1 — Import "./mock/StickyHero.data" … does not
 *     resolve to a file.
 *
 * The job row recorded all of it and landed `failed`. Then the tester opened
 * the project and got a raw Vite overlay from the preview child, while the
 * editor's own panel offered a guess: "the usual reason is that its generation
 * is still running … or that the generation failed." Both halves of that
 * sentence were available as fact, one endpoint away, and neither was fetched.
 *
 * A GUESS BETWEEN TWO STATES IS NOT A DIAGNOSIS. "Still running" and "failed"
 * call for opposite actions — wait, versus read the error and regenerate — and
 * this codebase has twice decided that inventing a state is the worse failure:
 * `interrupted` exists so a killed run is not reported as `failed`, and a 401
 * is its own state so a lapsed session is not reported as a regeneration
 * failure. This module is the same rule applied to opening a project.
 *
 * WHY IT IS SEPARATE FROM `App.tsx`. This workspace mounts no components (no
 * React testing library, and no new runtime dependencies), so logic inside the
 * panel would be untestable by construction — the same reasoning that pulled
 * `submitLogin` out of `LoginScreen` and `session-fetch.ts` out of `App.tsx`,
 * and the same `fetchImpl` seam.
 */
import { backend } from "./backend";
import { sessionAwareFetch } from "./session-fetch";

/** What the server says about the most recent `generate` job for a project. */
export type ProjectOpenFailure =
  /** A run is queued or in flight: there are legitimately no files yet. */
  | { readonly state: "generating"; readonly jobId: string }
  /** The run failed. `detail` is the server's own report, shown verbatim. */
  | { readonly state: "failed"; readonly jobId: string; readonly detail: string }
  /**
   * The server restarted mid-run. Deliberately NOT folded into `failed`: the
   * server cannot know whether the child finished, and `interrupted` exists
   * precisely so the UI says the outcome is unknown instead of inventing one.
   */
  | { readonly state: "interrupted"; readonly jobId: string }
  /**
   * No `generate` job explains this — it succeeded, or this project predates
   * the job model (every adopted acceptance run does), or the lookup itself
   * failed. The caller keeps its own generic message; this is not an
   * assertion that nothing is wrong.
   */
  | { readonly state: "unexplained" };

interface JobView {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
}

export interface ExplainOptions {
  /** Test seam; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Defaults to `backend.apiUrl("/api/jobs")`, which appends the `?project=`
   * that `GET /api/jobs` requires (it is project-scoped `BY_QUERY` in
   * `server/src/project-registry.ts`). Injectable because `backend` is a
   * module-level singleton bound to ambient `window.location`, which resolves
   * to LOCAL mode in a windowless test environment — so a test that relied on
   * the default would silently exercise a URL with no project on it.
   */
  readonly jobsUrl?: string;
}

/**
 * Asks `GET /api/jobs?project=…` why the project has no files.
 *
 * Goes through `sessionAwareFetch`, so a lapsed session throws
 * `SessionExpiredError` and the caller renders "sign in again" rather than
 * turning an auth problem into a generation failure. Every OTHER failure —
 * a 404, a proxy error page, malformed JSON — resolves `unexplained`, because
 * this function runs only when the caller is ALREADY reporting a problem and
 * must not replace a real message with an error about fetching an explanation.
 */
export async function explainUnopenableProject(
  options: ExplainOptions = {},
): Promise<ProjectOpenFailure> {
  const url = options.jobsUrl ?? backend.apiUrl("/api/jobs");
  const response = await sessionAwareFetch(url, { cache: "no-store" }, options.fetchImpl);
  if (!response.ok) return { state: "unexplained" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "unexplained" };
  }

  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return { state: "unexplained" };

  // Newest first (`listJobsByProject` orders by created_at DESC, rowid DESC), so
  // the first `generate` is the current one. Only `generate` is consulted: a
  // failed regen or export says nothing about whether the site has files, and
  // treating one as the reason would report a stale, unrelated error.
  const generate = (jobs as JobView[]).find((job) => job?.kind === "generate");
  if (generate === undefined || typeof generate.id !== "string") {
    return { state: "unexplained" };
  }

  const jobId = generate.id;
  switch (generate.status) {
    case "queued":
    case "running":
      return { state: "generating", jobId };
    case "interrupted":
      return { state: "interrupted", jobId };
    case "failed":
      return {
        state: "failed",
        jobId,
        // Verbatim: the server's text carries the gate report, and the whole
        // point is to show the diagnosis rather than a paraphrase of it. A
        // missing `error` still reports `failed` — the status is the fact, and
        // suppressing it for want of detail would be the original bug again.
        detail: typeof generate.error === "string" ? generate.error : "",
      };
    default:
      // `succeeded`, or a status this build does not know. A succeeded
      // generation that still cannot be opened is a DIFFERENT problem, and
      // claiming the generation failed would be a lie in the opposite
      // direction.
      return { state: "unexplained" };
  }
}
