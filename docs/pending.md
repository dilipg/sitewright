# Pending work — the living list

**Maintained deliberately.** Every item here is either open or explicitly
deferred with the reason. When an item closes, move it to "Recently closed"
with the commit, then prune that section once it is stale. Do not delete an
open item without recording why.

**Last updated:** 2026-08-11, after the local-tester-onboarding plan closed B1–B4
and its whole-branch review's fix round added P1 (correction) and R-1…R-6.

## The deployment model this list assumes

**Friends-and-family testers receive the full codebase and run it locally, each
with their own Anthropic key on their own machine.** This is a decision, not an
accident, and it changes severity across the whole list:

- There is **no shared hosted instance**, so no cross-tenant exposure.
- **BYOK stops being a risk transfer**: a tester's key never leaves their own
  machine, and the only briefs their generated code sees are their own.
- Every "multi-user" hardening item drops from *blocking* to *deferred*.

If that model ever changes to a shared hosted instance, **D1 and D2 below become
blocking immediately** and this section must be revisited first.

---

## E2E-BLOCKING — required before anyone can test end to end

**All four (B1–B4) are closed** — see "Recently closed" below. The three
things the README had to say plainly are said in its "What to expect" section,
and the section on rough edges links here rather than restating this file.

**Not needed:** production static serving of the editor. Testers run
`npm run dev:hosted -w editor` from source, and its Vite proxy already carries
`/api`, `/__*` and `/preview` same-origin to the server. (The plain `dev`
script is LOCAL mode and shows no login screen at all — corrected here because
this list said `dev` while the hosted shell needs `dev:hosted`.)

---

## OPEN — BLOCKING for Docker and for every non-Windows developer

| # | Item | Notes |
|---|---|---|
| **X1** | **Generation cannot complete on Linux or macOS — the product is Windows-only.** `design_pipeline.py:478,501`, `shell_pipeline.py:231,253` and `soak.py:45,56` spawn `["cmd", "/c", …]` for `npx tsc` and `mklink /J`. Measured inside the container: `FileNotFoundError: 'cmd'` | Discovered by task 3 while verifying the Docker image. `design_pipeline`'s call is inside a `@checkpoint`, so **a run dies after partial spend**. This makes the Docker workflow unable to do the one thing it exists for, and it is why the README must not promise generation under Docker until this is fixed |
| **X2** | **Export is also broken on Linux**: `compiler/src/exporter.ts:1224,1231` call `rmdirSync` on what is a junction on Windows and a symlink elsewhere → `ENOTDIR` | Two sites, both measured. `unlinkSync` is the portable call for a symlink; the comment at 1231 explicitly reasons about junctions |

## OPEN — data integrity

| # | Item | Notes |
|---|---|---|
| **P1** | **Manifest/code divergence under concurrent regens.** Two regens on one project share one preview child and one **unlocked** snapshot slot (`MAX_ACTIVE_JOBS_PER_USER` bounds per *user*, not per project); the second wipes the first's slot, and a later revert restores a manifest predating the first route's commit while that route's code stays regenerated. Reproduced by the F13 review | **Closed WITHIN ONE PROCESS** (task 5, decisions.md 2026-08-11): `snapshotRoute` now refuses while a still-running operation on a different route holds the slot, which is the whole of the two-browser-tabs bug — file half and manifest half alike, since both need the two runs to overlap. **Still open ACROSS processes**, and deliberately so: the claim is in-memory, so an orphaned orchestrator grandchild writing after its preview child died (H1), or a local preview server pointed at a hosted project's directory, is unguarded. That needs the manifest service's cross-process file lock or per-project serialisation of regen jobs — a lock *file* was rejected because a child killed mid-regen would leave a stale one that no endpoint can clear (C-2) |
| **P1 (correction)** | **The row above was FALSE when written, and is corrected here rather than rewritten** (the convention the 2026-08-10 F13 retraction set: a silently-rewritten record hides that a review caught it). The whole-branch review REPRODUCED the full corruption through the shipped guard: the claim was keyed by project root only, so a release freed whatever claim the project had, `restoreSnapshot` deleted the claim wholesale, and `/__regen-revert` was gated by nothing — so tab B reverting the route tab A was regenerating freed A’s claim (and destroyed A’s only pre-regen copy mid-write), after which `about` took the slot and A’s own `finally` freed *that* | **NOW closed within one process, and this time tested at the seam**: a claim is a handle whose `release()` can only free itself, and a revert is REFUSED while any claim is live (the fix round for the branch review; decisions.md 2026-08-11 correction row). Five tests, incl. the whole two-tab sequence through the real middleware; both halves perturbed. **Still open ACROSS processes, unchanged** (H1’s orphaned grandchild; a local preview server pointed at a hosted project’s directory) — in-memory state cannot see another process’s claim. **New, small, and deliberate:** a revert arriving mid-run is now refused with “wait for it to finish, then revert”, so a tester who wants to undo a running regeneration must wait ~11 minutes; that is strictly better than the silent corruption it replaces, and there is still no discard endpoint (C-2) |

## OPEN — money and correctness

| # | Item | Notes |
|---|---|---|
| **H1** | Killing a preview child orphans the orchestrator **grandchild**, which finishes, spends, and writes a usage log nobody ingests | **No evidence gained in round 1** — it killed the orchestrator tree directly, not a preview child. Costs the tester their own money, unrecorded |
| **H6** | `--out-dir` never threaded, so `--projects-root` is single-valued behind a refuse-to-boot | The refusal makes it impossible to have *silently*. Round 1 built the live harness its verification needs |
| **H4** | `runOnce()` is uncapped and bypasses `MAX_CONCURRENT_JOBS` | Latent: no production caller today |
| **H5** | The `job` table has no retention path; rows accumulate forever | Per-row size and queued count are both bounded |
| **H3** | Six concurrent proxied jobs can starve the preview pool and 503 a live preview | Needs multi-user load that a local single-user deployment does not produce |

## OPEN — unexplained or unverified

| # | Item | Notes |
|---|---|---|
| **H2** | **The fifth `..`.** A systematic audit of every place a client- or model-influenced string reaches a path, a URL, or a spawn argument | Four found at four layers, each by a different mechanism. Never done. Cheap, and hunts unknowns rather than confirming knowns. **First concrete lead, found 2026-08-10:** `editor/src/lib/jobs.ts:178` builds `new URL(\`/api/jobs/${jobId}\`, url)` with the id interpolated raw. **Not currently exploitable** — that id always arrives from a server 202 and is a `randomUUID()` — so it is latent, not live; but it is the same shape as all four shipped defects, and it goes live the moment any path lets that value be influenced |
| **F19** | Which mechanism carries fan-out resume — Kitaru's cache or `page_worker.py`'s `progress.json` skip | Round 1 proved the *outcome* (0 re-execution, 31% cost) but not the cause; no `progress.json` survives a finished project. Needs a run that inspects the filesystem *during* fan-out |
| **U1** | **`degraded_sections` is a one-shot notice.** The persisted job entry is cleared the instant a terminal status is observed, so a tester who reloads twice after a generation completes never learns a section shipped as a placeholder | Fixing it properly needs a per-project server-side record of the degraded set. Cosmetic for a trial, misleading at scale |
| **F17** | `manifest.json` key order is unstable across a regen — same keys, same byte count, different hash | Defeats hash-based change detection. Worth checking against 6.2's byte-identical export-zip guarantee |

## OPEN — cost and latency (measured, never remediated)

| # | Item | Notes |
|---|---|---|
| **W1** | Wall clock **676.8s**, over the 10-minute product ceiling | **71% of the miss is the prelude**, including a discarded primitives retry worth 152.7s and $0.36 alone. Per-section latency matches the model (29.2s vs 27.1s), so the lever is the prelude, not fan-out |
| **F18** | Zero prompt-cache reuse across the sequential page-regen loop | All six calls paid ~4,250 cache-creation tokens and read 0. Page-regen cost is strictly linear in section count |
| **F9** | The add-section HTTP API has **no position parameter**; `afterSection` is client-side only | An API-only consumer can only append. 7.6's "positioned by a `sectionOrder` override" holds for the editor path, not the API path |

## OPEN — docs accuracy and cosmetics

| # | Item | Notes |
|---|---|---|
| **D-1** | `2026-08-06-job-model-design.md:96` claims the preview pool's cap "does double duty, because every job needs a child" | **False for `generate`**, which takes no preview child. Corrected in a module comment and decisions.md, never in the spec |
| **D-2** | Docs say **20** archetypes; the live catalog has **27** | Verified 2026-08-10 |
| **D-3** | Docs describe `--projects-root` as a free choice | It is single-valued behind a refuse-to-boot |
| **C-1** | A mismatched-snapshot revert returns **500**, not 409/400 | Client-state conflict answered as a server error. Deliberately left to keep the F13 fix's blast radius to the data-loss guard |
| **C-2** | An unowned or foreign-owned snapshot slot can only be cleared by another billable regen | No discard endpoint; a hosted user has no filesystem access |
| **C-3** | Exporting `snapshotRoute`/`restoreSnapshot` for tests dropped the structural guarantee that every caller validates first | `snapshotRoute` can still copy from outside the project root; the destructive half is protected only incidentally by `.split(".")[0]` yielding `""` for `..` |
| **R-1** | **Duplicated session/fetch/error-message rails across the four new hosted screens** (whole-branch review, M2). `resolveFetch` appears three times verbatim (`LoginScreen.tsx`, `ProjectPicker.tsx`, `GenerationProgress.tsx`); the 401 → `SessionExpiredError` rail is hand-rolled four times although `session-fetch.ts` exists to be it; the “try `.json()`, read `.error`, else `(HTTP n)`” reader appears three times | Not fixed: behaviour agrees today and each divergence is justified in a comment. The duplication is load-bearing rather than accidental — each component’s `fetchImpl` seam is typed `typeof fetch` with the 401 check inlined below it, which is what makes them testable with no React testing library. The cost is that ADDING a session state (a 403 for a disabled account, say) has four sites and three message readers, and nothing would fail if one were missed |
| **R-2** | **`App.test.ts`’s describe block overclaims** (M3): it is named “every read goes through the session-aware layer (finding B)” but checks two functions, while `openAddSection`’s `/__archetypes` and `editPlanBrief`’s `/__plan/section-brief` are still bare `fetch` with no `.ok` check | Not fixed: both reads are PRE-EXISTING (neither is in this branch’s diff), so the code is not a regression — the test NAME is the finding. `editPlanBrief` is the one with teeth: fire-and-forget, so a 401 silently discards the tester’s edited section brief and `approvePlan` then approves a plan whose edit never landed |
| **R-3** | **The progress endpoint ships an `events` array no client reads** (M4): up to `MAX_PROGRESS_EVENTS` (500) `{type, at}` entries, the largest part of a payload polled every 5s for ~11 minutes. `GenerationProgress`’s `ProgressView` deliberately omits the field | Not fixed: harmless at tester scale, and the field is the natural shape for a future timeline. Related to R-4 — the parse that builds it is most of that endpoint’s cost |
| **R-4** | **`readProgress` is a synchronous whole-file read plus a `JSON.parse` per event, on the server’s event loop** (M5). Measured against real logs: 823 KB / 58 events → 3.5 ms; the largest log in `orchestrator/runlog/` (7.8 MB / 485 events) → 28.9 ms — per poll, per client, every 5s, on the thread that also proxies previews and runs the job worker | Not fixed: comfortable for a local single-user tester. Recorded because the cost is proportional to a file that only grows, and because the parse is spent almost entirely on fields the response then discards (R-3) |
| **R-5** | **Dead and missing CSS** (M6): `.account-gate-hint` has no remaining consumer (task 3’s picker replaced the placeholder that used it); `.progress-row` is rendered but has no rule | Not fixed: cosmetic. Noted because the rest of the new CSS is carefully class-prefixed, which is why none of it can reach the milestone-7 Playwright suite |
| **R-6** | **There is no sign-out** (M7). The branch adds a login screen and a “Signed in as …” line, but nothing in `editor/src` calls `POST /api/logout`, which already exists. The README points at the operator CLI, which can only disable the whole account | Not fixed: one button against an existing endpoint, but out of the fix round’s scope. On the shared machine the account line exists to guard against, there is no way to end a session from the UI |

## DEFERRED — gated on the deployment model

| # | Item | Why deferred, and what un-defers it |
|---|---|---|
| **D1** | Same-origin preview removed the iframe sandbox, and generated code is model-authored from a free-text brief, so a prompt injection could exfiltrate the stored API key over the user's own session. A 5-step cross-origin migration is written down (wildcard DNS, wildcard TLS, cookie scoping or a signed proxy token, tightening the shim's `postMessage` from `"*"` — still `"*"` at `compiler/src/shim/shim.ts:47` — and re-checking the geometry protocol cross-origin) | Under local single-user deployment this is **self-attack**: the tester's own machine, own key, own brief. **Becomes blocking the moment a shared hosted instance exists** |
| **D2** | Preview children run as the same OS user and can read each other's directories | Single user per deployment. Same trigger as D1 |
| **D3** | Production static serving of the editor | Not needed: testers run the Vite dev server from source. Becomes real only for a hosted instance |

## Recently closed

| Item | Commit |
|---|---|
| **B3** progress for a running generation: `GET /api/jobs/:id/progress`, read from the orchestrator's own run log rather than a second write path | `d6da8f0` |
| **B1** login screen in the editor (hosted mode only; no sign-up link, no reset link — both would be dead ends) | `4ccf01b` |
| **B2** project picker + new-site brief form; a project is reached by opening it, not by pasting a UUID into `?project=` | `0b1bd54` |
| **B3 (UI half)** live generation progress: stage, sections done, elapsed against the measured ~11 minutes, `degraded_sections`, and `interrupted` rendered as an unknown outcome | `7c39be7` |
| **P1 (in-process half)** a second concurrent snapshot is refused instead of replacing the first | `8390cfa` |
| **B4** a root `README.md`, written and then followed literally from a clean shell against a fresh database and a fresh master key | this commit |
| **F13** cross-route data loss: a global snapshot slot let reverting one route delete another | `ab5f349` |
| **F13 review findings 2–5**: the same destructive-before-validated shape twice more in the same two functions; owner slug normalised on write; the editor's `revertRegen` had no `.ok` check so a refusal rendered as success | `31454f8` |
| **F3** every generated site shipped `<title><UNKNOWN></title>` + `"name": "unknown"` into the handover export | `8b7d66c` |
| **7.6 / 7.9 / fan-out resume** verified against a live model for the first time | `95068c3` |
| **H7 (part)** two stale `CLAUDE.md` claims corrected (`/__archetypes`, the 15-primitive drift) | `d80cc05` |
| **F20 EXPLAINED, not a defect** — 9 section checkpoints producing 8 files is designed behaviour: `home.community-values` failed gates on all 3 attempts, exhausted `MAX_ATTEMPTS`, and shipped as a `<FailedSectionPlaceholder />` (present in `home/index.tsx`). The placeholder deliberately carries no `data-node-id` and no manifest entry, because no agent proposed one and a stray id would fail gate 4. **It was reported correctly**: the job result carries `degraded_sections: ["home.community-values"]`, and its own cost total matches `usage_event` to the cent | investigated 2026-08-10 |
