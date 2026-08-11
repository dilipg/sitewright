import { describe, expect, it } from "vitest";
import App from "./App";
// Vite's own `?raw` suffix (typed by `vite/client`, referenced from
// src/vite-env.d.ts) rather than `node:fs` — this workspace's tsconfig has no
// node types, and adding `@types/node` for one test would be a new dependency.
import appSource from "./App.tsx?raw";

describe("editor test runner", () => {
  it("runs (P0 placeholder)", () => {
    expect(typeof App).toBe("function");
  });
});

/**
 * WHOLE-BRANCH REVIEW, FINDING B.
 *
 * `App` is a React component and this workspace has no React testing library
 * (and may not add one — "no new runtime dependencies"), so its internal
 * functions cannot be invoked from a unit test. The BEHAVIOUR of the fix lives
 * in `lib/session-fetch.ts` and is properly tested there; what these assert is
 * that `App.tsx` actually ROUTES through it — the half that a component test
 * would cover and a library test structurally cannot.
 *
 * Source-text assertions, following the precedent `server/src/compose.test.ts`
 * sets for `scripts/serve.ts` (a module whose body cannot be imported for a
 * unit test either). They are narrow on purpose: each reads one named
 * function's own body, not the whole file.
 */
/** The body of `async function <name>(` up to its closing brace at the same indent. */
function functionBody(name: string): string {
  const start = appSource.indexOf(`async function ${name}(`);
  expect(start, `App.tsx no longer declares "async function ${name}("`).toBeGreaterThan(-1);
  const indent = /\n(\s*)$/.exec(appSource.slice(0, start))?.[1] ?? "";
  const end = appSource.indexOf(`\n${indent}}`, start);
  expect(end, `could not find the end of ${name}`).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe("App.tsx: every read goes through the session-aware layer (finding B)", () => {
  it("refreshManifest reads through fetchJson, never a bare fetch", () => {
    // A bare `fetch` here is the exact defect: a hosted 401's body parses as
    // JSON, so `manifest.nodes` became undefined and render threw at
    // `manifest?.nodes[selectedId]` — and, since both regen paths call this
    // after the job already succeeded, the same 401 was reported as a regen
    // FAILURE for work that landed.
    const body = functionBody("refreshManifest");
    // `<unknown>` since C2: the value is not a `Manifest` until
    // `isManifestShaped` says so, and a cast that asserts the shape is what
    // let a `{error}` body through in the first place.
    expect(body).toContain('fetchJson<unknown>(backend.previewUrl("/manifest.json")');
    expect(body).not.toMatch(/[^a-zA-Z]fetch\(/);
  });

  it("refreshManifest validates the manifest's shape before storing it", () => {
    const body = functionBody("refreshManifest");
    // A 200 carrying something that is not a manifest is a DIFFERENT failure
    // from a 401 carrying something that parses, and it is the one that
    // actually reached the DOM. The check itself now lives in
    // `lib/canvas.ts` (C2) and is unit-tested there; what this asserts is that
    // this reader still runs it, and still throws rather than storing.
    expect(body).toContain("isManifestShaped(loaded)");
    expect(body).toContain("throw new Error");
  });

  /**
   * WHOLE-BRANCH REVIEW, C2 — the OTHER reader of `manifest.json`.
   *
   * The finding-B fix above was applied to `refreshManifest` and not to the
   * canvas bootstrap four hundred lines above it in the same file, which read
   * `.json()` straight into state. Task 3's picker then made that reader
   * reachable in one click, on a project whose directory is legitimately empty
   * for the ~11 minutes a generation takes (and forever, if it failed): the
   * preview pool's JSON failure body became `manifest = {error}`, and
   * `routesFromManifest` threw inside a `useMemo` DURING RENDER with no error
   * boundary above it — a blank page, and no route back, because the picker
   * renders only when `?project=` is absent.
   */
  it("the bootstrap validates the manifest before it reaches state, like refreshManifest", () => {
    const body = functionBody("bootstrap");
    // A status check first, so a 503/401 body is never parsed as a manifest...
    expect(body).toContain('fetchJson<unknown>(backend.previewUrl("/manifest.json"))');
    expect(body).not.toMatch(/\.json\(\) as Promise<Manifest>/);
    // ...and the same shape guard as the other reader, BEFORE setManifest.
    expect(body).toContain("if (!isManifestShaped(manifestJson)) throw new Error");
    const guardIndex = body.indexOf("isManifestShaped(manifestJson)");
    const storeIndex = body.indexOf("setManifest(manifestJson)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(storeIndex).toBeGreaterThan(guardIndex);
  });

  it("a bootstrap failure leaves a way back to the project list, not a blank page", () => {
    // The state is held, not merely logged...
    expect(appSource).toContain("setBootstrapError(");
    // ...and rendered as its own screen, in hosted mode only (local mode keeps
    // today's console.error-and-sit-on-Loading behaviour, and the milestone-7
    // Playwright suite runs there).
    expect(appSource).toContain("if (hostedMode && bootstrapError !== null) {");
    // The way back is a real navigation that drops `?project=`, which is what
    // makes the picker render again — a reload alone reproduced the dead end.
    expect(appSource).toContain("editorUrlWithoutProject(window.location.href)");
    const branchIndex = appSource.indexOf("if (hostedMode && bootstrapError !== null) {");
    expect(appSource.indexOf('data-testid="bootstrap-error-back"')).toBeGreaterThan(branchIndex);
  });

  /**
   * WHOLE-BRANCH REVIEW, I1. `/api/me` carries the money fields the picker
   * renders beside the Generate button, and it was read once per tab: after a
   * ~$1.74 run the tester was told "$10.00 of your $10.00 daily budget is left
   * ($0.00 spent)" beside the button that had just spent it. Five runs later it
   * still said $10.00 and the next Generate was refused 402 — the precise
   * failure that line was added to prevent.
   */
  it("re-reads /api/me when a generation ends, so the budget line is not stale money", () => {
    const start = appSource.indexOf("void fetchJson<AccountSummary>(meUrl()");
    expect(start, "App.tsx no longer reads /api/me through fetchJson").toBeGreaterThan(-1);
    // The dependency IS the fix: `startedGeneration` returns to null on the one
    // path back to the picker, so this fires on exactly that edge.
    const effectTail = appSource.slice(start, start + 600);
    expect(effectTail).toContain("}, [startedGeneration]);");
  });

  /**
   * TASK 2 — the login screen is gated on hosted mode, and local mode must
   * not render it at all.
   *
   * Source-text again, for the same structural reason as the tests around it:
   * this is JSX inside a component that cannot be mounted here. The BEHAVIOUR
   * of the request lives in `components/LoginScreen.tsx` and is tested
   * directly; what this asserts is the half a library test structurally
   * cannot — that App reaches it only under `hostedMode`.
   *
   * The end-to-end proof for local mode is `e2e/hosted-mode.spec.ts`, which
   * fakes a 401 against the bare, unauthenticated local URL and asserts the
   * DISMISSIBLE BANNER appears. Forcing `isHostedMode` on breaks that spec as
   * well as this test.
   */
  it("renders the login screen only in hosted mode, never in local mode", () => {
    expect(appSource).toContain("const showLogin = hostedMode && sessionExpired;");
    // The single flag, reused. A second "not logged in yet" state would be the
    // same fact recorded twice, free to disagree with this one.
    expect(appSource).not.toMatch(/useState.*notLoggedIn|useState.*loggedOut/i);
  });

  it("skips the canvas bootstrap when hosted mode has no project yet", () => {
    // Otherwise every bootstrap URL resolves against the LOCAL preview server
    // on :5273, which a hosted tester is not running: a hang with no banner,
    // the exact failure class the bootstrap `.catch` was added to end.
    expect(appSource).toContain(
      "const hostedShellWithoutProject = hostedMode && backend.projectId === undefined;",
    );
    const bootstrapEffect = appSource.slice(
      appSource.indexOf("async function bootstrap()") - 600,
      appSource.indexOf("async function bootstrap()"),
    );
    expect(bootstrapEffect).toContain("if (hostedShellWithoutProject) return;");
  });

  /**
   * TASK 3 — the picker replaces task 2's placeholder, and the id it hands
   * back is the API's id.
   *
   * Source-text again, for the same structural reason as everything around
   * it: this is JSX inside a component that cannot be mounted here. The
   * BEHAVIOUR (`startGeneration`, `toProjectRows`, `loadProjects`) is tested
   * directly in `components/ProjectPicker.test.ts`; what these assert is the
   * half a library test structurally cannot — that App reaches the picker at
   * all, and that what it does with the picker's output is a navigation
   * carrying that exact id.
   */
  it("renders the project picker in the hosted shell, replacing task 2's placeholder", () => {
    expect(appSource).toContain("<ProjectPicker");
    expect(appSource).toContain("onOpen={openProject}");
    // The picker is reached ONLY from the hosted-shell branch, so local mode
    // (and the whole milestone-7 Playwright suite, which navigates to a bare
    // `/` with the flag unset) never renders it.
    const pickerIndex = appSource.indexOf("<ProjectPicker");
    const branchIndex = appSource.indexOf("if (hostedShellWithoutProject) {");
    expect(branchIndex).toBeGreaterThan(-1);
    expect(pickerIndex).toBeGreaterThan(branchIndex);
  });

  it("opens a project by the ID the API returned — App never touches a directory", () => {
    // This codebase's most repeated mistake, guarded at the layer that
    // performs the navigation as well as the layer that shapes the list. A
    // project's id and its on-disk run directory are BOTH UUIDs, and
    // `requireProject` answers a wrong-UUID request with the same 404 it
    // gives a foreign project — so the failure would read as "that project
    // does not exist" for a project that plainly does.
    // `functionBody` above only finds `async function`s; `openProject` is
    // synchronous (it navigates and nothing follows), so it is sliced here.
    const start = appSource.indexOf("function openProject(");
    expect(start, 'App.tsx no longer declares "function openProject("').toBeGreaterThan(-1);
    const body = appSource.slice(start, appSource.indexOf("\n  }", start));
    expect(body).toContain("editorUrlForProject(projectId,");
    expect(appSource).not.toMatch(/\.directory\b/);
    expect(appSource).not.toMatch(/["']directory["']/);
  });

  it("holds BOTH ids a started generation produced, since they name different things", () => {
    // `jobId` is what the progress view polls; `projectId` is what the editor
    // opens once it succeeds. Storing the whole object rather than one field
    // is what keeps the second available when the first finishes — and, since
    // task 4, what makes a persisted run restorable at all: a jobId alone
    // could be polled but never opened.
    expect(appSource).toContain("useState<StartedGeneration | null>(");
    expect(appSource).toContain("onGenerationStarted={setStartedGeneration}");
    // Both fields survive a resume, which replaces only the job id.
    expect(appSource).toContain("onResumed={(jobId) => setStartedGeneration({ ...startedGeneration, jobId })}");
  });

  /**
   * TASK 4 — the progress view replaces task 3's `generation-started`
   * placeholder. The property that placeholder's test named ("does not offer to
   * open a project whose generation has only just started") did not go away: it
   * moved INTO `GenerationProgress.tsx`, where `GenerationProgress.test.ts`
   * asserts it against the running block's own source text, and it is now
   * stronger there — it bans "back to your sites" during a paid run as well.
   * `POST /api/generate` creates the project row AND its directory before
   * queueing the job, so a project legitimately exists with an empty directory
   * for the ~11 minutes the run takes; opening it then bootstraps a canvas
   * against a manifest that does not exist yet.
   */
  it("hands a started generation to the progress view, which owns the ~11-minute wait", () => {
    expect(appSource).toContain("<GenerationProgress");
    // `openProject` is reachable only as the SUCCESS callback. The component
    // invokes it from its terminal screen; App never renders an open
    // affordance of its own beside a running job.
    expect(appSource).toContain("onDone={openProject}");
    const branchIndex = appSource.indexOf("if (hostedShellWithoutProject) {");
    expect(branchIndex).toBeGreaterThan(-1);
    expect(appSource.indexOf("<GenerationProgress")).toBeGreaterThan(branchIndex);
  });

  it("restores a run that outlived its tab, because starting a second costs $1.74", () => {
    // THE money requirement. Held only in tab state, a reload during an
    // ~11-minute run returned the tester to the picker with a real run still
    // going; they conclude it failed and press Generate again — and the
    // per-user bound is 2, so the second one succeeds and is billed.
    expect(appSource).toContain("restorePersistedRun(localRunStorage())");
    expect(appSource).toContain("persistRun(localRunStorage(), startedGeneration)");
    // Local mode must not read or write this key at all: no session, no job
    // table, no worker, and the milestone-7 Playwright suite runs there.
    expect(appSource).toContain(
      "hostedShellWithoutProject ? restorePersistedRun(localRunStorage()) : null",
    );
  });

  it("approvePlan dismisses the plan gate only after the write actually landed", () => {
    const body = functionBody("approvePlan");
    expect(body).toContain("sessionAwareFetch(");
    expect(body).toContain("response.ok");
    // The ordering is the property: `setPendingPlan(null)` must come after the
    // ok check, never before it and never unconditionally. Dismissing the gate
    // for an approval that never happened drops the user into the editor
    // believing generation is unblocked while the server still has
    // plan-status.json unapproved.
    const okIndex = body.indexOf("response.ok");
    const dismissIndex = body.indexOf("setPendingPlan(null)");
    expect(dismissIndex).toBeGreaterThan(okIndex);
    expect(body).toContain("SessionExpiredError");
  });
});
