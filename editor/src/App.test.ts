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
    expect(body).toContain("fetchJson<Manifest>(");
    expect(body).not.toMatch(/[^a-zA-Z]fetch\(/);
  });

  it("refreshManifest validates the manifest's shape before storing it", () => {
    const body = functionBody("refreshManifest");
    // A 200 carrying something that is not a manifest is a DIFFERENT failure
    // from a 401 carrying something that parses, and it is the one that
    // actually reached the DOM.
    expect(body).toContain("loaded.nodes");
    expect(body).toContain("throw new Error");
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
