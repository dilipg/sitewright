/**
 * Enqueue-and-poll integration (slice 5, job model: editor/src/lib/jobs.ts).
 *
 * The webServer this whole e2e suite runs against
 * (compiler/scripts/preview.ts) is the LOCAL, unauthenticated backend: it
 * answers every one of these endpoints SYNCHRONOUSLY with 200 and never
 * creates a job at all (the job-model design doc's own words: "No compiler
 * changes"). Nothing driven only through that server can ever exercise the
 * 202-then-poll path — wiring the editor to the hosted server is explicitly
 * NOT this task (task-4 brief).
 *
 * Route interception stands in for the hosted server's shape instead: it
 * fakes exactly the two responses a real hosted server would send (202
 * `{jobId}`, then `GET /api/jobs/:id` bodies) and proves the EDITOR's own
 * handling of `{queued, running, succeeded, failed, interrupted}` is
 * correct, independent of which backend produced it. This is the one place
 * that class of bug (an unhandled `interrupted`, or "succeeded" wrongly
 * read as "the work passed") would be caught automatically at all.
 */
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, selectNode } from "./helpers";

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
});

/** Fakes a hosted-server enqueue: the first call to `path` answers 202 with
 *  a job id; every call to `GET /api/jobs/<jobId>` after that is handled by
 *  `pollBody`, called once per poll with the 1-based poll number so a test
 *  can return a few non-terminal bodies before a terminal one. */
async function fakeJob(
  page: import("@playwright/test").Page,
  path: string,
  jobId: string,
  pollBody: (pollNumber: number) => unknown,
): Promise<void> {
  await page.route(`**${path}`, async (route) => {
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId }) });
  });
  let pollNumber = 0;
  await page.route(`**/api/jobs/${jobId}`, async (route) => {
    pollNumber += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pollBody(pollNumber)) });
  });
}

async function openRegenPrompt(page: import("@playwright/test").Page): Promise<void> {
  await openEditor(page);
  await selectNode(page, "home.hero");
  await page.getByTestId("regen-button").click();
  await page.getByTestId("regen-confirm").click();
}

/* ---------- the polling loop itself ---------- */

test("a 202 enqueue is polled (queued -> running -> succeeded) and the terminal result is applied exactly as a synchronous 200 would be", async ({
  page,
}) => {
  await fakeJob(page, "/__regen", "job-roundtrip", (n) =>
    n < 3 ? { status: n === 1 ? "queued" : "running" } : { status: "succeeded", result: { passed: true, orphanedOverrides: [] } },
  );
  await openRegenPrompt(page);

  await expect(page.getByTestId("regen-progress")).toBeVisible();
  await expect(page.getByTestId("regen-progress")).toBeHidden({ timeout: 15_000 });
  // no failure panel and no interrupted banner -- a clean success
  await expect(page.getByTestId("regen-failure")).toHaveCount(0);
  await expect(page.getByTestId("job-interrupted-banner")).toHaveCount(0);
});

test("elapsed time visibly ticks upward while a job runs -- honest progress, not a fabricated percentage", async ({
  page,
}) => {
  // Isolates the LOCAL 1s ticker (App.tsx) from enqueueAndPoll's own
  // onStatus, which only fires once every `pollIntervalMs` (2000ms in
  // production): the fake job answers "running" on poll 1 (fired almost
  // immediately after the 202), so onStatus's own next update does not
  // land until ~2000ms out. A window well under that (1500ms) can only be
  // satisfied by the ticker itself -- if onStatus alone were the only thing
  // moving this number, this assertion would still be waiting at "0s".
  await fakeJob(page, "/__regen", "job-ticking", (n) =>
    n < 4 ? { status: "running" } : { status: "succeeded", result: { passed: true } },
  );
  await openRegenPrompt(page);

  const progress = page.getByTestId("regen-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("0s");
  await expect(progress).toContainText(/[1-9]\d*s/, { timeout: 1_500 });
});

/* ---------- THE TRAP: "succeeded" means the request completed, not that the work passed ---------- */

test("THE TRAP (regen): a 'succeeded' job whose OWN result.passed is false is a gate failure, not a success", async ({
  page,
}) => {
  await fakeJob(page, "/__regen", "job-trap-regen", () => ({
    status: "succeeded",
    result: { passed: false, failureReport: "gate 3 (tokens-only): fake trap failure" },
  }));
  await openRegenPrompt(page);

  const failure = page.getByTestId("regen-failure");
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await expect(failure).toContainText("fake trap failure");
  // and NOT treated as success
  await expect(page.getByTestId("revert-regen-button")).toHaveCount(0);
});

test("THE TRAP (add-a-section): a 'succeeded' job whose OWN result.passed is false fails the add, not the poll", async ({
  page,
}) => {
  await fakeJob(page, "/__add-section", "job-trap-add", () => ({
    status: "succeeded",
    result: { passed: false, failureReport: "fake add-section trap failure" },
  }));
  await openEditor(page);
  await page.getByTestId("add-section-slot-home.hero").click({ force: true });
  await expect(page.getByTestId("add-section-panel")).toBeVisible();
  await expect(page.getByTestId("archetype-stats-band")).toBeVisible();
  await page.getByTestId("archetype-stats-band").click();
  await page.getByTestId("add-section-instruction").fill("Three headline metrics with labels.");
  await page.getByTestId("add-section-confirm").click();

  await expect(page.getByTestId("add-section-running")).toBeVisible();
  const failed = page.getByTestId("add-section-failed");
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("add-section-report")).toContainText("fake add-section trap failure");
});

test("THE TRAP (edit-prompt): a 'succeeded' job whose OWN result carries an error is rejected, not applied", async ({
  page,
}) => {
  await fakeJob(page, "/__edit-prompt", "job-trap-edit", () => ({
    status: "succeeded",
    result: { error: "fake edit-prompt trap failure" },
  }));
  await openEditor(page);
  await page.getByTestId("edit-prompt-input").fill("make the headline shorter");
  await page.getByTestId("edit-prompt-submit").click();

  await expect(page.getByTestId("edit-prompt-errors")).toContainText("fake edit-prompt trap failure", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("edit-prompt-summary")).toHaveCount(0);
});

test("THE TRAP (export): a 'succeeded' job whose OWN result says ok:false is a failed export, not a success", async ({
  page,
}) => {
  await fakeJob(page, "/__export", "job-trap-export", () => ({
    status: "succeeded",
    result: { ok: false, message: "fake export trap failure" },
  }));
  await openEditor(page);
  await page.getByTestId("export-button").click();

  await expect(page.getByTestId("export-failed-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("export-failure-message")).toContainText("fake export trap failure");
  await expect(page.getByTestId("export-download")).toHaveCount(0);
});

/* ---------- a request-level "failed" job (distinct from a gate failure) ---------- */

test("a job-level 'failed' status (e.g. the preview child could not start) surfaces through the same failed-regen panel a thrown error always did", async ({
  page,
}) => {
  await fakeJob(page, "/__regen", "job-failed-regen", () => ({
    status: "failed",
    error: "could not start the preview",
  }));
  await openRegenPrompt(page);

  const failure = page.getByTestId("regen-failure");
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await expect(failure).toContainText("could not start the preview");
});

/* ---------- 'interrupted' is not a synonym for 'failed' ---------- */

test("an interrupted regen shows the honest 'outcome unknown' banner, never the 'Regeneration failed' panel", async ({
  page,
}) => {
  await fakeJob(page, "/__regen", "job-interrupted-regen", () => ({ status: "interrupted" }));
  await openRegenPrompt(page);

  const banner = page.getByTestId("job-interrupted-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/outcome is unknown/i);
  await expect(banner).toContainText(/check the page/i);
  // the word "failed" must never appear anywhere in this surface -- that is
  // exactly the lie the design doc warns against
  await expect(page.getByTestId("regen-failure")).toHaveCount(0);

  await page.getByTestId("job-interrupted-dismiss").click();
  await expect(banner).toBeHidden();
});

test("an interrupted add-a-section shows the honest banner, not the 'Could not add the section' panel", async ({
  page,
}) => {
  await fakeJob(page, "/__add-section", "job-interrupted-add", () => ({ status: "interrupted" }));
  await openEditor(page);
  await page.getByTestId("add-section-slot-home.hero").click({ force: true });
  await page.getByTestId("archetype-stats-band").click();
  await page.getByTestId("add-section-instruction").fill("Three headline metrics with labels.");
  await page.getByTestId("add-section-confirm").click();

  await expect(page.getByTestId("job-interrupted-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("add-section-failed")).toHaveCount(0);
});

test("an interrupted edit-prompt shows the honest banner, not a rejection", async ({ page }) => {
  await fakeJob(page, "/__edit-prompt", "job-interrupted-edit", () => ({ status: "interrupted" }));
  await openEditor(page);
  await page.getByTestId("edit-prompt-input").fill("make the headline shorter");
  await page.getByTestId("edit-prompt-submit").click();

  await expect(page.getByTestId("job-interrupted-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("edit-prompt-errors")).toHaveCount(0);
  // the submit button returns to its idle label rather than staying stuck
  await expect(page.getByTestId("edit-prompt-submit")).toHaveText("Apply");
});

test("an interrupted export shows the honest banner, not the export failure panel", async ({ page }) => {
  await fakeJob(page, "/__export", "job-interrupted-export", () => ({ status: "interrupted" }));
  await openEditor(page);
  await page.getByTestId("export-button").click();

  await expect(page.getByTestId("job-interrupted-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("export-panel")).toHaveCount(0);
  // the button itself returns to idle rather than being stuck "Exporting…"
  await expect(page.getByTestId("export-button")).toHaveText("Export");
});

test("the preview frame stays interactive while a job is queued/running -- only the affected flow shows busy state", async ({
  page,
}) => {
  await fakeJob(page, "/__regen", "job-slow", (n) => (n < 2 ? { status: "running" } : { status: "succeeded", result: { passed: true } }));
  await openRegenPrompt(page);

  await expect(page.getByTestId("regen-progress")).toBeVisible();
  // a different route's frame is unaffected and fully addressable
  await expect(previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]')).toBeVisible();
});
