import { expect, test } from "@playwright/test";
import { openEditor, resetOverrides, selectNode } from "./helpers";

/**
 * A smoke test for HOSTED MODE ITSELF (task-8 review): nothing before this
 * ran `App.tsx` with `?project=` at all — `backend` is a module-scope
 * singleton resolved once at import time, `vitest` is windowless (so
 * `backend.test.ts` only ever exercises `createBackend`/`resolveMode`
 * directly, never the real singleton in hosted mode), and every other e2e
 * spec navigates to `/` with no `?project=`. So "hosted mode actually
 * renders" was, until this test, an inference from string-building unit
 * tests rather than an observation of the running app.
 *
 * No real hosted server (`server/`) runs against this suite — webServer #1
 * is the LOCAL, unauthenticated compiler preview (compiler/scripts/
 * preview.ts) — so every request hosted mode makes is faked via route
 * interception, the identical technique `jobs.spec.ts` already uses to fake
 * the hosted server's shape without running it.
 */

const PROJECT_ID = "p1";

const FAKE_MANIFEST = {
  version: 1,
  nodes: {
    "home.hero": {
      route: "/",
      file: "src/pages/home/Hero.tsx",
      component: "Hero",
      element: "Section",
      editable: [],
      status: "active",
    },
  },
};

test("hosted mode (?project=<id>): the preview iframe is proxied at /preview/<id>/<route>, and compiler calls carry ?project=<id>", async ({
  page,
}) => {
  const apiRequestPaths: string[] = [];
  // "**/__**" (not "**/__*"): a single "*" does not cross a "/" boundary in
  // Playwright's glob matching, so it would miss a nested path like
  // `/__overrides/home` (matching only sibling-less ones like `/__plan`) --
  // caught empirically: the narrower pattern let `/__overrides/<slug>`
  // fall through to the REAL dev server, which (correctly, per this same
  // task's vite.config.ts change) proxied it to the hosted server's port
  // and got ECONNREFUSED, since no real hosted server runs in this suite.
  await page.route("**/__**", async (route) => {
    const url = new URL(route.request().url());
    apiRequestPaths.push(url.pathname + url.search);
    if (url.pathname === "/__plan") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: false, approved: true }),
      });
      return;
    }
    if (url.pathname === "/__overrides-history") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 1, snapshots: [{}], index: 0 }),
      });
      return;
    }
    if (url.pathname.startsWith("/__overrides/")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 1, route: "/", overrides: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) });
  });

  const previewRequestPaths: string[] = [];
  await page.route(`**/preview/${PROJECT_ID}/**`, async (route) => {
    const url = new URL(route.request().url());
    previewRequestPaths.push(url.pathname);
    if (url.pathname.endsWith("/manifest.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FAKE_MANIFEST) });
      return;
    }
    if (url.pathname.endsWith("/tokens.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    // The route page itself, requested as the iframe's own document -- a
    // real preview would run the bridge shim here, but nothing in this
    // test asserts on the iframe's CONTENTS, only that the request for it
    // was made to the right, project-scoped URL at all.
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body>stub</body></html>" });
  });

  await page.goto(`/?project=${PROJECT_ID}`);

  // The iframe's `src` attribute is the literal, unresolved string
  // `backend.previewUrl(route.path)` produced -- `/preview/<id>/`, never
  // the local server's `http://localhost:5273/`.
  await expect(page.locator('iframe[title="preview-home"]')).toHaveAttribute(
    "src",
    `/preview/${PROJECT_ID}/`,
  );

  // At least one compiler endpoint carried `?project=<id>` -- bootstrap
  // alone makes several (`/__plan`, `/__overrides/home`,
  // `/__overrides-history`), so this also stands in for "backend.apiUrl
  // fixed the /__archetypes-with-no-?project= defect the same way."
  expect(apiRequestPaths.some((path) => path.includes(`project=${PROJECT_ID}`))).toBe(true);
  // And the preview was actually reached under the project-scoped prefix,
  // not silently skipped.
  expect(previewRequestPaths.some((path) => path.startsWith(`/preview/${PROJECT_ID}/`))).toBe(true);
});

/* ---------- a 401 OUTSIDE the four job-backed flows (task-8 review) ----------
 * `sessionAwareFetch` was originally wired only into the four `enqueueAndPoll`
 * call sites. The review found two more places a 401 was reachable the
 * instant this task made 401 possible at all: bootstrap (the very first
 * thing the editor does) and the debounced autosave/export pre-flush write
 * (`writeOverrides`) -- neither checked `response.ok` at all, so a 401 there
 * either hung silently (bootstrap: an unhandled rejection, the canvas never
 * renders) or was worse than silent (autosave: `setSaveStatus("Saved")` ran
 * unconditionally, actively lying about an edit that never reached disk).
 * Both are LOCAL-mode-server-agnostic: this fakes the 401 via route
 * interception on top of the real, unauthenticated local server, exactly as
 * `jobs.spec.ts` fakes the hosted server's job shape without running one --
 * hosted mode's own `?project=` is not needed to exercise `sessionAwareFetch`
 * itself, only a 401 response on the right path. */

test("a 401 during bootstrap (e.g. an already-expired session on a bookmarked hosted URL) surfaces the session-expired banner, not a silent hang", async ({
  page,
}) => {
  await page.route("**/__plan", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "not authenticated" }) }),
  );

  await page.goto("/");

  await expect(page.getByTestId("session-expired-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("session-expired-banner")).toContainText(/session expired/i);
  // it never gets far enough to leave the save status stuck saying it
  // loaded fine
  await expect(page.getByTestId("save-status")).not.toHaveText("Saved");
});

test("an override write that 401s during autosave does not report 'Saved' for an edit that never reached disk, and shows the session-expired banner instead", async ({
  page,
}) => {
  await resetOverrides(page);
  await openEditor(page);
  await selectNode(page, "home.hero.eyebrow");

  // Only the WRITE 401s -- bootstrap's own GETs (already completed by the
  // time this test edits anything) and any other route must keep working,
  // so this fakes the failure as narrowly as the real one would ever be:
  // a session that was fine a moment ago and lapses mid-session.
  await page.route("**/__overrides/home", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "not authenticated" }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByTestId("visibility-toggle").click();

  await expect(page.getByTestId("session-expired-banner")).toBeVisible({ timeout: 15_000 });
  // THE lie this fix exists to prevent: "Saved" must never appear for this
  // edit once its own write 401'd.
  await expect(page.getByTestId("save-status")).not.toHaveText("Saved");
});

/**
 * `sessionAwareFetch` only ever intercepts a 401 -- writeOverrides' OWN
 * `.ok` check (added alongside it) is what stops a DIFFERENT failure (a
 * 500, a 413 over `MAX_BODY_BYTES`, anything non-401) from the identical
 * false "Saved". This is a distinct code path from the 401 test above, not
 * a duplicate of it: perturbing this test's target (writeOverrides' `.find
 * ((response) => !response.ok)` check) while leaving `sessionAwareFetch`
 * itself untouched does NOT make the 401 test above fail, since a 401
 * throws inside `sessionAwareFetch` before that check is ever reached --
 * verified while writing this suite (task-8 review round 2), which is
 * exactly why this second test exists rather than treating the first as
 * sufficient coverage.
 */
test("an override write that fails for a reason OTHER than session expiry (e.g. 500) also does not report 'Saved' for an edit that never reached disk", async ({
  page,
}) => {
  await resetOverrides(page);
  await openEditor(page);
  await selectNode(page, "home.hero.eyebrow");

  await page.route("**/__overrides/home", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
      return;
    }
    await route.continue();
  });

  await page.getByTestId("visibility-toggle").click();

  // Not a session expiry, so no banner -- but "Saved" must still never
  // appear for this edit, and the toggle's own visible effect (this is a
  // real, uncontested UI change, not merely an override write) proves the
  // click was registered at all, so a stuck "Saving…" isn't just this
  // click never having landed.
  await expect(page.getByTestId("visibility-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1000); // clears the 300ms debounce with margin
  await expect(page.getByTestId("save-status")).not.toHaveText("Saved");
  await expect(page.getByTestId("session-expired-banner")).toHaveCount(0);
});
