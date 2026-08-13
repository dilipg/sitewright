# Pending work — the living list

**Maintained deliberately.** Every item here is either open or explicitly
deferred with the reason. When an item closes, move it to "Recently closed"
with the commit, then prune that section once it is stale. Do not delete an
open item without recording why.

**Last updated:** 2026-08-13, after fix round B closed I7, R-6 (picker half), C-1
(revert half), R-5 and D-1/D-2/D-3, and recorded three remainders in their place.
Round A's own entries are the 2026-08-12 rows in decisions.md.

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
| **C-2** | An unowned or foreign-owned snapshot slot can only be cleared by another billable regen | No discard endpoint; a hosted user has no filesystem access |
| **C-3** | Exporting `snapshotRoute`/`restoreSnapshot` for tests dropped the structural guarantee that every caller validates first | `snapshotRoute` can still copy from outside the project root; the destructive half is protected only incidentally by `.split(".")[0]` yielding `""` for `..` |
| **R-1** | **Duplicated session/fetch/error-message rails across the four new hosted screens** (whole-branch review, M2). `resolveFetch` appears three times verbatim (`LoginScreen.tsx`, `ProjectPicker.tsx`, `GenerationProgress.tsx`); the 401 → `SessionExpiredError` rail is hand-rolled four times although `session-fetch.ts` exists to be it; the “try `.json()`, read `.error`, else `(HTTP n)`” reader appears three times | Not fixed: behaviour agrees today and each divergence is justified in a comment. The duplication is load-bearing rather than accidental — each component’s `fetchImpl` seam is typed `typeof fetch` with the 401 check inlined below it, which is what makes them testable with no React testing library. The cost is that ADDING a session state (a 403 for a disabled account, say) has four sites and three message readers, and nothing would fail if one were missed |
| **R-2** | **`App.test.ts`’s describe block overclaims** (M3): it is named “every read goes through the session-aware layer (finding B)” but checks two functions, while `openAddSection`’s `/__archetypes` and `editPlanBrief`’s `/__plan/section-brief` are still bare `fetch` with no `.ok` check | Not fixed: both reads are PRE-EXISTING (neither is in this branch’s diff), so the code is not a regression — the test NAME is the finding. `editPlanBrief` is the one with teeth: fire-and-forget, so a 401 silently discards the tester’s edited section brief and `approvePlan` then approves a plan whose edit never landed |
| **R-3** | **The progress endpoint ships an `events` array no client reads** (M4): up to `MAX_PROGRESS_EVENTS` (500) `{type, at}` entries, the largest part of a payload polled every 5s for ~11 minutes. `GenerationProgress`’s `ProgressView` deliberately omits the field | Not fixed: harmless at tester scale, and the field is the natural shape for a future timeline. Related to R-4 — the parse that builds it is most of that endpoint’s cost |
| **R-4** | **`readProgress` is a synchronous whole-file read plus a `JSON.parse` per event, on the server’s event loop** (M5). Measured against real logs: 823 KB / 58 events → 3.5 ms; the largest log in `orchestrator/runlog/` (7.8 MB / 485 events) → 28.9 ms — per poll, per client, every 5s, on the thread that also proxies previews and runs the job worker | Not fixed: comfortable for a local single-user tester. Recorded because the cost is proportional to a file that only grows, and because the parse is spent almost entirely on fields the response then discards (R-3) |
| **N1** | **`node-loadable.test.ts` checks that a shipped `.ts` can be STRIPPED, not that its imports RESOLVE.** Fix round B hit the consequence: `compiler/src/index.ts`'s extensionless value re-exports broke the editor's whole Playwright suite (the `webServer` could not boot) while every other check stayed green | Fixed at the site (extensions added, with the reason in the file's header) but NOT guarded. A text-level guard produces false positives on `regen-api.ts`'s generated-code template literals, which contain real-looking `import ... from "../../../primitives/Heading"` lines for the code it EMITS; a sound guard needs AST parsing, or a smoke test that actually `import()`s each package entry point under Node |
| **C-1 (remainder)** | A `/__regen`, `/__regen-page` or `/__add-section` refused because another route's regeneration still holds the snapshot slot answers **500**, like the revert used to | Fix round B mapped only the REVERT to 409 (its own item). The same reasoning applies to the three snapshot-TAKING endpoints, but each has its own `catch` and its own tests, and widening it was not this round's item. `snapshotRoute` would need the same typed error |
| **C-1 (client half)** | The 409's REASON never reaches the user. `revertRegen` reads through `fetchJson`, which throws `request failed: HTTP 409` before touching the body, so the panel shows a number where the server sent "wait for it to finish, then revert" | Unchanged by fix round B, which fixed the STATUS. `fetchJson` is the shared rail every hosted screen reads through (R-1), so making it surface `.error` is a change with four callers and its own assertions |
| **R-6 (remainder)** | Sign-out exists on the project picker only. From an open canvas (`?project=<id>`) there is no sign-out and no "back to your sites" either — the way back exists only on the bootstrap-error screen | The picker is where the "Signed in as …" line lives, so that is where the button belongs; adding a second copy to the canvas header means duplicating the request/error state R-1 already flags. A tester on a shared machine must return to the sites list (or drop `?project=`) to sign out |

## DEFERRED — gated on the deployment model

| # | Item | Why deferred, and what un-defers it |
|---|---|---|
| **D1** | Same-origin preview removed the iframe sandbox, and generated code is model-authored from a free-text brief, so a prompt injection could exfiltrate the stored API key over the user's own session. A 5-step cross-origin migration is written down (wildcard DNS, wildcard TLS, cookie scoping or a signed proxy token, tightening the shim's `postMessage` from `"*"` — still `"*"` at `compiler/src/shim/shim.ts:47` — and re-checking the geometry protocol cross-origin) | Under local single-user deployment this is **self-attack**: the tester's own machine, own key, own brief. **Becomes blocking the moment a shared hosted instance exists** |
| **D2** | Preview children run as the same OS user and can read each other's directories | Single user per deployment. Same trigger as D1 |
| **D3** | Production static serving of the editor | Not needed: testers run the Vite dev server from source. Becomes real only for a hosted instance |

## Recently closed

| **Fix round B (2026-08-13)** | Commit |
|---|---|
| **I7 CLOSED — a resume can no longer switch model families mid-`run_id`.** A job's provider is stamped by `recordJobRun` alongside `run_id`/`code_version`, and a resume whose recorded provider differs from the account's current one is refused **409 naming both**. `job-provider.ts` is the ONE comparison, checked at enqueue AND at claim time (a resumed job can sit `queued` for minutes while the key is swapped — the same door task-7-review finding 3 closed for code versions). A **null** recorded provider does NOT refuse: nothing ran, and every `export` job and every pre-column row carries one. Perturbing the refusal away, and perturbing null into a refusal, each fail named tests | this commit |
| **R-6 CLOSED (picker) — there is a sign-out.** `POST /api/logout` finally has a caller: `lib/logout.ts`, beside the account line, hosted-only via the same optional-prop guard `onOpenKeySettings` uses. A FAILED sign-out is reported rather than smoothed into a login screen while the cookie still works; `onSignedOut` drops the persisted run and reloads, so no stale account email, project list or key state survives. Canvas half left open above | this commit |
| **C-1 CLOSED (revert) — a refused revert answers 409, not 500.** Four refusals (wrong owner, live claim, incomplete slot, nothing to revert) throw a typed `RevertConflictError` the handler maps to 409 with the guard's own message; a genuine failure inside the copy still answers 500, pinned by a test that forces one. The three snapshot-taking endpoints are left at 500 above | this commit |
| **R-5 CLOSED — dead and missing CSS.** `.account-gate-hint` deleted (no consumer since the picker replaced the placeholder); `.progress-row` written, declaring the stack it had been getting from block flow plus the `min-width: 0` its server-worded head needs inside a 560px panel. No automated guard exists for either — a general class-usage lint reports false positives on this codebase's template-literal class names | this commit |
| **D-1, D-2, D-3 CLOSED — three stale doc claims corrected, never rewritten.** Dated corrections appended beside each original, per the F13-retraction convention: the pool cap does NOT do double duty for `generate` (which takes no child — `MAX_CONCURRENT_JOBS` is what bounds it); the catalog is **27**, not 20, the extra eight being an app set added later (and §4.3 has a fifth page archetype, `app-screen`); `--projects-root` is single-valued behind a refuse-to-boot, so both 2026-08-05 plan docs' scratch-root instructions cannot be followed as written. All three are STALE DESCRIPTIONS, not specs the code violates — stated explicitly, since the standing rule forbids editing docs to make code pass | this commit |

| **H2 CLOSED — the fifth `..` was found, and it was real.** `manifest.ts`'s `propose` validated only `nodeId`; `component` and `file` are equally MODEL-AUTHORED (they arrive in an agent's structured output) and were persisted verbatim, then interpolated into `path.join` at six sites including the real exporter (`exporter.ts:621,719,933`, `regen-api.ts:760,761,898,927`). `path.join` normalises `..`, so either field could read or write outside the project. Validated at the proposal boundary — the one place model output becomes persisted state — so all six joins are protected by construction rather than by six people remembering. Patterns chosen AFTER sampling a real generated manifest (every component already PascalCase, every file relative under `src/pages/`), so nothing legitimate is rejected. 6 new tests; removing the guard fails 4 by name (the absolute-path case is already caught by the existing `ownership` rule, so it does not discriminate for this guard — reported rather than glossed) | this commit |

| **X1 CLOSED — the product is no longer Windows-only.** Seven spawn sites (`design_pipeline`, `shell_pipeline`, `soak`, and `fanout`'s `Popen(list, shell=True)`, found only after the other six) now go through `orchestrator/portable.py`, which BRANCHES rather than substitutes: a junction on Windows (no elevation needed), `os.symlink` on POSIX, `shutil.which` for `npx`, and never a list with `shell=True`. **Proven live: a complete site generated inside Docker** — $1.4516689 over 18 `usage_event` rows, 9m09s, 2 routes, 8 of 9 sections, browser export 60 files. A regression guard (`test_portability_guard.py`) fails CI on an eighth site | `96ca50c`, `18118c9`, `e96f9ac` |
| **X2 CLOSED — export works off Windows.** `exporter.ts` branches on `lstatSync` instead of assuming a junction; `rmdirSync` on a POSIX symlink was `ENOTDIR`, thrown from a `finally`, which turned a SUCCESSFUL export into a failure and masked any real `ExportError`. Verified in Linux from the CLI and through the browser UI | `96ca50c` |
| **Docker workflow**: one image with Node + Python + uv, volumes for `generated/` and the identity DB, master-key persistence verified with a negative control (a different key gives `UndecryptableApiKeyError`), and `WEBGEN_FANOUT_MAX_WORKERS` so unbounded fan-out stops OOMing a small VM | `c5aa7c7`, `18118c9` |
| **BYOK form** with provider choice, replacing two curl commands; spend says "at least" whenever `unpricedEvents > 0`, so the accepted Gemini cap-degradation is visible rather than silent | `254b8af`, `4d787d0`, `9265b24` |
| **README is Docker-first.** The coordinator followed the **quickstart** literally from `docker compose down -v` — steps 1 to 5, ending at the settings form and the project picker — and every one of those worked verbatim. **The original claim here was "zero corrections forced", which overstated its scope and is corrected rather than rewritten:** the follow stopped before Generate and never exercised the later "commands you will want" section, where the whole-branch review then found three `docker compose exec … npm test -w` commands that cannot work from `working_dir: /app/server` (fixed with `--workdir /app`), plus a false claim that the spend cap "will stop you eventually" on a Gemini-only account (it never does — `SUM` skips `NULL`) | `d85ac1a`, corrected in this commit |

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
