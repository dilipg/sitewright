# Pending work — the living list

**Maintained deliberately.** Every item here is either open or explicitly
deferred with the reason. When an item closes, move it to "Recently closed"
with the commit, then prune that section once it is stale. Do not delete an
open item without recording why.

**Last updated:** 2026-08-10, after round 1 (live verification) merged as `95068c3`.

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

| # | Item | Why it blocks |
|---|---|---|
| **B1** | **Login screen in the editor.** `POST /api/login` exists; there is **no UI for it anywhere** (zero matches for `api/login` in `editor/src`). Every project-scoped route composes over `requireSession`, so without this there is no way to authenticate from a browser at all | A tester cannot get past the first request |
| **B2** | **Project list + "new site" brief form.** `GET /api/projects` and `POST /api/generate` both exist and are unused by any UI. Today a project id must be read out of `user-cli list-projects` and pasted into the URL as `?project=<uuid>` | A tester cannot create or choose a site |
| **B3** | **Progress for a running generation.** A generation takes ~11 minutes and there is **no progress signal of any kind** — no `progress` column, nothing between `queued` and `succeeded` | Without it, most feedback will be "it seemed stuck", which wastes the trial rather than testing the product |
| **B4** | **A root `README.md`.** None exists. Needs: prerequisites, `WEBGEN_MASTER_KEY` (base64, not hex), `orchestrator/.env`, the operator CLI to create the first account, both dev servers, and the three caveats below | A tester cannot start |

**Three things the README must tell testers plainly**, because all three are by
design and all three look like bugs:

1. **There is no cancellation.** A mistyped brief costs ~$1.74 and ~11 minutes
   (spec decision 13: the subprocess cannot be safely killed mid-run).
2. **`interrupted` means the outcome is genuinely unknown**, not failed — it is
   what a restart during a run produces, and the server cannot know whether the
   child finished.
3. **A generation costs real money on their own key** — ~$1.74 measured, ~11
   minutes, and the per-user spend cap defaults are worth setting.

**Not needed:** production static serving of the editor. Testers run
`npm run dev -w editor` from source, and its Vite proxy already carries `/api`,
`/__*` and `/preview` same-origin to the server.

---

## OPEN — data integrity

| # | Item | Notes |
|---|---|---|
| **P1** | **Manifest/code divergence under concurrent regens.** Two regens on one project share one preview child and one **unlocked** snapshot slot (`MAX_ACTIVE_JOBS_PER_USER` bounds per *user*, not per project); the second wipes the first's slot, and a later revert restores a manifest predating the first route's commit while that route's code stays regenerated. Reproduced by the F13 review | **Silent corruption.** Reachable by ONE tester with two browser tabs, so it does not fully disappear under local single-user deployment. The manifest service has a cross-process file lock; the snapshot slot has none. Highest-priority non-blocking item |

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
| **H2** | **The fifth `..`.** A systematic audit of every place a client- or model-influenced string reaches a path, a URL, or a spawn argument | Four found at four layers, each by a different mechanism. Never done. Cheap, and hunts unknowns rather than confirming knowns |
| **F19** | Which mechanism carries fan-out resume — Kitaru's cache or `page_worker.py`'s `progress.json` skip | Round 1 proved the *outcome* (0 re-execution, 31% cost) but not the cause; no `progress.json` survives a finished project. Needs a run that inspects the filesystem *during* fan-out |
| **F20** | Nine section checkpoints produced eight sections | Unexplained. A resume silently discarding completed work would be a cost bug |
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

## DEFERRED — gated on the deployment model

| # | Item | Why deferred, and what un-defers it |
|---|---|---|
| **D1** | Same-origin preview removed the iframe sandbox, and generated code is model-authored from a free-text brief, so a prompt injection could exfiltrate the stored API key over the user's own session. A 5-step cross-origin migration is written down (wildcard DNS, wildcard TLS, cookie scoping or a signed proxy token, tightening the shim's `postMessage` from `"*"` — still `"*"` at `compiler/src/shim/shim.ts:47` — and re-checking the geometry protocol cross-origin) | Under local single-user deployment this is **self-attack**: the tester's own machine, own key, own brief. **Becomes blocking the moment a shared hosted instance exists** |
| **D2** | Preview children run as the same OS user and can read each other's directories | Single user per deployment. Same trigger as D1 |
| **D3** | Production static serving of the editor | Not needed: testers run the Vite dev server from source. Becomes real only for a hosted instance |

## Recently closed

| Item | Commit |
|---|---|
| **F13** cross-route data loss: a global snapshot slot let reverting one route delete another | `ab5f349` |
| **F13 review findings 2–5**: the same destructive-before-validated shape twice more in the same two functions; owner slug normalised on write; the editor's `revertRegen` had no `.ok` check so a refusal rendered as success | `31454f8` |
| **F3** every generated site shipped `<title><UNKNOWN></title>` + `"name": "unknown"` into the handover export | `8b7d66c` |
| **7.6 / 7.9 / fan-out resume** verified against a live model for the first time | `95068c3` |
| **H7 (part)** two stale `CLAUDE.md` claims corrected (`/__archetypes`, the 15-primitive drift) | `d80cc05` |
