# Local Tester Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the product usable end to end from a browser by someone who clones the repo, so friends-and-family testers can go brief → generated site → edit → export without touching a CLI after setup.

**Architecture:** Three screens added to the **existing editor React app** (login, project picker + new-site form, generation progress), plus one read-only progress endpoint on the server and a root README. No server-side HTML and no production static serving: testers run the editor's Vite dev server from source, and its proxy already carries `/api`, `/__*` and `/preview` same-origin to the hosted server. Every endpoint these screens need already exists except progress.

**Tech Stack:** React 19 + Vite + TS (`editor/`), Node 24 + `node:sqlite` + hand-rolled router (`server/`), Python 3.12/uv/Kitaru (`orchestrator/`).

**Deployment model this plan assumes:** each tester runs the whole stack **locally with their own Anthropic key**. There is no shared hosted instance. See [docs/pending.md](../../pending.md) for what that defers and what would un-defer it.

## Global Constraints

- **No HTTP route may create a user.** Account creation exists **only** in `server/src/user-cli.ts`. Invite-only is structural. The login screen carries **no sign-up link**.
- **Local mode must stay byte-identical.** `compiler/scripts/preview.ts` stays unauthenticated and local; the milestone-7 Playwright suite must stay green **without weakening any assertion**. Absent `?project=`, the editor must behave exactly as it does today.
- **Nothing may log or persist API-key material.** Only a last-4 fingerprint may reach the UI.
- **`WEBGEN_MASTER_KEY` is canonical padded base64, not hex.** A hex key passes the canonicality check and fails only on length (`got 48`).
- **Auth lives at the HTTP boundary only.** The orchestrator CLIs, `compiler/scripts/preview.ts` and `npm run check` must never require a login.
- **Never modify `docs/` to make code pass.** Appending a `docs/decisions.md` row is required and is not a violation.
- **A `succeeded` job means the request completed, not that the work passed.** The success field differs per endpoint: `passed` for regen/add-section/edit-prompt, `ok` for `/__export`, **neither** for `generate` (result is `{stdout}`; a gate failure lands `failed`).
- **A project's id and its on-disk directory are different UUIDs.** HTTP takes the id; filesystem paths take the run id. `GET /api/jobs/:id` does not expose `run_id`.
- **A 401 is its own state**, distinguishable from a job failure. Reporting "generation failed" for a lapsed session is the same lie `interrupted` exists to prevent.
- **Every new endpoint must appear in `server/src/project-registry.ts`**, which is a partition of the live route table — an endpoint added without an authorization rule fails a test.
- **Any client- or model-influenced string reaching a path, URL, or spawn argument is a `..` hazard.** Four such defects have shipped at four layers. Reuse `isSafeRunId` rather than writing a new check.
- No new runtime dependencies. Red tests never cross a commit boundary. Migrations append-only and idempotent.
- **Every test must fail if the behaviour it names is removed.** Perturb, watch it fail, restore. **If a perturbation does not fail, say so** rather than moving on.

---

### Task 1: A progress endpoint over the run log

**Files:**
- Create: `server/src/progress-routes.ts`, `server/src/progress-routes.test.ts`
- Modify: `server/src/compose.ts` (mount), `server/src/project-registry.ts` (register)

**Interfaces:**
- Produces: `GET /api/jobs/:id/progress` → `{ stage, stagesDone, sectionsGenerated, sectionsTotal | null, events }`

**Why read the run log rather than add a `progress` column:** the orchestrator
already appends one event per completed stage (`intake.complete`,
`plan.complete`, `tokens.complete`, `primitives.complete` — **twice**, it retries
— `shell.complete`) plus one `section.generated` and one `section.validated` per
section. That is a real progress signal that already exists. A new column would
be a second write path that can disagree with the log, and the log is what the
DAG report already trusts.

- [ ] **Step 1: Write the failing test**

```ts
it("reports the stage and section counts for a running generate job", () => {
  // A run log with the prelude done and 2 of an unknown number of sections
  const log = join(runlogDir, `${runId}.jsonl`);
  writeFileSync(log, [
    JSON.stringify({ event_type: "intake.complete", run_id: runId }),
    JSON.stringify({ event_type: "plan.complete", run_id: runId }),
    JSON.stringify({ event_type: "section.generated", run_id: runId }),
    JSON.stringify({ event_type: "section.generated", run_id: runId }),
  ].join("\n"), "utf8");

  const res = call("GET", `/api/jobs/${jobId}/progress`);
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ sectionsGenerated: 2, stage: "generating sections" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/src/progress-routes.test.ts`
Expected: FAIL — the route is not registered, so the router 404s.

- [ ] **Step 3: Implement**

Session-only and **owner-checked on `job.user_id`**, answering the shared
`NOT_FOUND` constant for a foreign or absent job — identically, so it is not an
enumeration oracle. Read `run_id` from the job row (it is not in
`publicJobView`), **validate it with `isSafeRunId` before it reaches a path**
(the regex `^[A-Za-z0-9._-]+$` matched `..` once already, which is why that
helper exists), and read the log with `readFileSync`. A missing log is `200` with
zero counts, not a 404 — a job that has not started yet legitimately has no log.

- [ ] **Step 4: Tests pass, then perturb**

Delete the `isSafeRunId` call and confirm a traversal test fails. Delete the
owner check and confirm the foreign-job test fails. **Name which tests failed.**

- [ ] **Step 5: Commit**

`feat(server): report generation progress from the run log`

---

### Task 2: Login screen in the editor

**Files:**
- Create: `editor/src/components/LoginScreen.tsx`, `editor/src/components/LoginScreen.test.tsx`
- Modify: `editor/src/App.tsx`, `editor/src/App.css`

**Interfaces:**
- Consumes: `POST /api/login` `{email, password}` — **`Content-Type: application/json` is required**, which is what closes login-CSRF; `GET /api/me`
- Produces: `<LoginScreen onAuthenticated={() => void}>`

- [ ] **Step 1: Write the failing test**

```ts
it("submits as JSON, because a form-encoded login is refused by design", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = async (_u: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ id: "u1", email: "a@b.c" }), { status: 200 });
  };
  await submitLogin("a@b.c", "pw", { fetchImpl });
  expect((calls[0]!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
});

it("reports a failed login without revealing which field was wrong", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid email or password" }), { status: 401 });
  await expect(submitLogin("a@b.c", "wrong", { fetchImpl })).rejects.toThrow(/invalid email or password/);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run editor/src/components/LoginScreen.test.tsx`

- [ ] **Step 3: Implement**

A `submitLogin` helper (testable without mounting React — `App.test.ts` cannot
mount components and no testing library may be added) plus a small form
component. **Surface the server's uniform failure message verbatim**; never
guess which field was wrong, because the uniform response is deliberate — it is
what stops the form being an account-enumeration oracle.

**No sign-up link, no "create account" affordance, no password-reset link.** All
three would be dead ends: account creation exists only in the operator CLI, and
there is no email-based recovery. The README covers both.

Wire it in `App.tsx`: in **hosted mode only**, when the bootstrap or a request
yields a 401, render `<LoginScreen>` instead of the canvas. Reuse the existing
`sessionExpired` state rather than adding a parallel one. **Local mode must not
render it at all.**

- [ ] **Step 4: Tests pass, then perturb** — change the header to
`application/x-www-form-urlencoded` and confirm the first test fails. Make the
error message name the field and confirm the second fails.

- [ ] **Step 5: Commit** — `feat(editor): add a login screen for hosted mode`

---

### Task 3: Project picker and new-site form

**Files:**
- Create: `editor/src/components/ProjectPicker.tsx`, `editor/src/components/ProjectPicker.test.tsx`
- Modify: `editor/src/App.tsx`, `editor/src/lib/backend.ts`, `editor/src/App.css`

**Interfaces:**
- Consumes: `GET /api/projects` → `{projects: [...]}`; `POST /api/generate` `{brief}` → **202** `{jobId, projectId}`; `GET /api/jobs/:id`; Task 1's progress endpoint
- Produces: `<ProjectPicker onOpen={(projectId) => void}>`

- [ ] **Step 1: Write the failing test**

```ts
it("treats a 202 from generate as the START of work, not a result", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ jobId: "j1", projectId: "p1" }), { status: 202 });
  const started = await startGeneration("a site for a bakery", { fetchImpl });
  expect(started).toEqual({ jobId: "j1", projectId: "p1" });
});

it("refuses to submit an empty brief without calling the server", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response("{}", { status: 202 }); };
  await expect(startGeneration("   ", { fetchImpl })).rejects.toThrow(/brief/i);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run editor/src/components/ProjectPicker.test.tsx`

- [ ] **Step 3: Implement**

Shown in hosted mode when there is **no `?project=`**. Lists the user's projects
with a name and created date; opening one sets `?project=<id>` so the existing
hosted-mode path takes over unchanged. The brief form posts `/api/generate`,
takes `{jobId, projectId}`, and hands both to Task 4's progress view.

**Reject an empty brief client-side before spending anything** — the server
answers 400, but a round trip to be told you typed nothing is worse than not
making the call.

Add a `projectsUrl()`/`generateUrl()` to `backend.ts` rather than building URLs
inline: that module **owns every URL the editor constructs**, and a project id
reaching a path needs its double-escaping (`%2E` then `encodeURIComponent`,
because WHATWG URL normalization treats `%2e` as a literal dot).

- [ ] **Step 4: Tests pass, then perturb** — make `startGeneration` treat 202 as
a finished result and confirm the first test fails; remove the empty-brief guard
and confirm the second fails.

- [ ] **Step 5: Commit** — `feat(editor): add a project picker and new-site form`

---

### Task 4: Generation progress view

**Files:**
- Create: `editor/src/components/GenerationProgress.tsx`, `editor/src/components/GenerationProgress.test.tsx`
- Modify: `editor/src/App.tsx`, `editor/src/App.css`

**Interfaces:**
- Consumes: Task 1's `GET /api/jobs/:id/progress`; `GET /api/jobs/:id`
- Produces: `<GenerationProgress jobId projectId onDone onFailed>`

- [ ] **Step 1: Write the failing test**

```ts
it("shows `interrupted` as an unknown outcome, never as a failure", () => {
  expect(describeTerminal("interrupted")).toMatch(/unknown/i);
  expect(describeTerminal("interrupted")).not.toMatch(/failed/i);
});

it("keeps polling through a transient progress error instead of declaring failure", async () => {
  // A progress read is advisory; the JOB status is authoritative.
  const states = await collect(pollUntilTerminal({
    jobStatuses: ["running", "running", "succeeded"],
    progressErrors: [true, false, false],
  }));
  expect(states.at(-1)).toBe("succeeded");
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run editor/src/components/GenerationProgress.test.tsx`

- [ ] **Step 3: Implement**

Poll the job every 3s and progress every 5s. **The job status is authoritative;
progress is advisory** — a failed progress read must never turn a running job
into a reported failure. Render the current stage, sections done, and elapsed
time.

**Three states must read honestly, and all three are load-bearing:**
- `succeeded` → open the project.
- `failed` → say it failed, show the error, and offer **Resume** (`POST /api/jobs/:id/resume`) — but note a resume is refused **409** after a restart, since `code_version` is read once at boot.
- **`interrupted` → "the outcome is unknown"**, never "failed". The server cannot know whether the child finished. This is what a restart during a run produces and a tester **will** hit it.

Show the elapsed time against an honest expectation (**~11 minutes measured**),
and state that there is **no cancellation** — spend continues regardless.

- [ ] **Step 4: Tests pass, then perturb** — make `interrupted` render as
"failed" and confirm the first test fails; make a progress error abort the poll
and confirm the second fails.

- [ ] **Step 5: Commit** — `feat(editor): show live generation progress`

---

### Task 5: The snapshot lock (P1)

**Files:**
- Modify: `compiler/src/regen-api.ts`, `compiler/src/regen-api.test.ts`

**Why this is in a tester-onboarding plan:** it is **silent** corruption, and it
is reachable by ONE tester with two browser tabs — `MAX_ACTIVE_JOBS_PER_USER` is
2. A tester hitting it reports "my page broke" and the trial spends its time
chasing a known bug.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses a second concurrent snapshot rather than silently replacing the first", () => {
  const root = twoRouteProject();
  snapshotRoute(root, "home");
  // `about`'s regen must not be allowed to discard `home`'s pending snapshot.
  expect(() => snapshotRoute(root, "about")).toThrow(/pending regeneration/i);
  expect(readFileSync(join(root, ".regen-backup", "route.txt"), "utf8")).toBe("home");
});

it("allows a fresh snapshot once the pending one has been consumed", () => {
  const root = twoRouteProject();
  snapshotRoute(root, "home");
  restoreSnapshot(root, "home");
  expect(() => snapshotRoute(root, "about")).not.toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run compiler/src/regen-api.test.ts`

- [ ] **Step 3: Implement**

`snapshotRoute` refuses when an **owned** slot already exists for a *different*
route, instead of wiping it. Re-snapshotting the **same** route must keep
working — that is the ordinary retry path and the page-regen path.

The failure must be loud at the endpoint (the handler's existing `catch` returns
500 with the message), and the message must say what to do: revert or discard
the pending regeneration first.

**Record in `docs/decisions.md`** that this closes the *file* half of P1 and
whether manifest/code divergence is fully closed by it or still needs
per-project serialisation. Do not overclaim: the F13 review's finding 1 was that
a previous justification here was wrong.

- [ ] **Step 4: Tests pass, then perturb** — allow the overwrite again and
confirm the first test fails. Then confirm the whole `regen-api.test.ts` file
still passes, including the F13 tests.

- [ ] **Step 5: Commit** — `fix(compiler): refuse a second concurrent snapshot instead of replacing it`

---

### Task 6: The root README

**Files:**
- Create: `README.md`
- Modify: `docs/pending.md` (move B1–B4 to "Recently closed")

- [ ] **Step 1: Write it**

Audience: a competent developer who has never seen this repo and wants to
generate a site. It must be followable **start to finish with no other
document**, and it must be *tested* by following it literally in Step 2.

Cover, in order: what the product does; prerequisites (**Node ≥ 22.13** for
`node:sqlite` — check the real `engines` field; Python 3.12; `uv`); `npm install`;
`orchestrator/.env` with `ANTHROPIC_API_KEY`; generating `WEBGEN_MASTER_KEY` —
**canonical padded base64, and say plainly that a hex key fails with a
misleading `got 48` length error**; creating the first account with
`node server/scripts/user.ts create --email … --db "$DB"` (note `--db` is
**cwd-relative**, so pass an absolute path, and that `set-cap` takes `--usd`);
setting a spend cap; starting the server; starting `npm run dev -w editor`;
logging in; generating a first site.

Then a **"What to expect"** section stating plainly:

- a generation costs **~$1.74** and takes **~11 minutes** on your own key;
- there is **no cancellation** — a mistyped brief spends anyway;
- **`interrupted` means the outcome is unknown**, not failed;
- accounts are created **only** by the operator CLI; there is no sign-up and no
  password reset by email.

And a **"Known rough edges"** section linking [docs/pending.md](docs/pending.md)
rather than duplicating it, so the two cannot drift.

- [ ] **Step 2: Follow it literally, from a clean shell**

Do not skip this. Use a **fresh `--db` path** and a **fresh master key** so the
first-run experience is real. Every command must work **as written**. Any step
that needs knowledge not in the README is a README bug — fix the README, not your
shell. Report every correction you had to make.

- [ ] **Step 3: Commit** — `docs: add a README for local deployment`

---

## What this plan does not do

- **No production static serving, no cross-origin preview, no per-user isolation.** All three are properties of a *shared hosted* instance, which this deployment model does not create. See [docs/pending.md](../../pending.md) D1–D3 and the trigger that un-defers them.
- **No cancellation** (spec decision 13: the subprocess cannot be safely killed) and **no password reset**. Both are documented for testers instead.
- **No wall-clock or prompt-cache work** (W1, F18). Measured, reported, and survivable once progress is visible.
- **Nothing from H1–H6, H2, F9, F17, F19, F20.** Tracked in `docs/pending.md`.
