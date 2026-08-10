# Post-slice-5 hardening: the pending inventory, ranked — and round 1, live verification

**Date:** 2026-08-10
**Status:** approved in brainstorming; round 1 ready to plan
**Follows:** `2026-08-06-job-model-design.md` (slice 5, merged as `5272a69`)

## What this document is

Slice 5 merged and the branch is clean. This document does two separate jobs,
deliberately at two different resolutions:

1. **It enumerates every pending item in the project and ranks them**, with the
   reasoning for the ranking. This is the complete picture, and it is the part
   that survives being wrong about details.
2. **It designs round 1 in full** — a live-verification round. Only round 1 gets
   a task plan now. Everything after it is ranked but not detailed, because
   round 1's findings will reorder it. Planning the grandchild-orphan fix or the
   `..` audit in detail before three live runs have reported would be planning
   on sand.

## The record, corrected

Two items `CLAUDE.md` lists as open are **already closed**. Both were found by
checking the code rather than trusting the note, and both would otherwise have
cost a future session real work:

- **`/__archetypes` called with no `?project=`.** Closed by task 8 — the call
  goes through `backend.apiUrl` (`editor/src/App.tsx:972`), with a unit test
  (`editor/src/lib/backend.test.ts:78`) and an e2e comment naming the fix.
  `CLAUDE.md`'s 4c-2 paragraph still says it is open, and its stated reason
  ("harmless only because the editor is not yet wired to the hosted server at
  all") is also stale — task 8 wired it.
- **The "full 15-primitive set" doc drift.** Corrected on 2026-08-02
  (`docs/decisions.md:206`). `docs/build-plan-v1.md:69` and
  `docs/build-prompts-v1.md:280` both name `Notice` now. `CLAUDE.md`'s
  milestone-7 paragraph still flags it as "open for a human call."

**`CLAUDE.md` needs both statements corrected.** It is the file loaded into
every future session, and it currently asserts that two closed items are open.
That edit is recommended for round 1 but is **not bundled into it** — the human
chose the round scope without docs corrections, and this is flagged for an
explicit call rather than taken silently.

## The pending inventory, ranked

Thirteen genuinely open items (V2–V4, H1–H7, D1–D3), plus one control run — V1 —
added by this design rather than inherited from anywhere. The ranking follows
from one decision recorded below: **nobody else gets access for the foreseeable
future.** That single fact demotes the entire security-isolation group and
promotes verification.

### Round 1 — live verification (this document designs it)

| # | Item | Why it leads |
|---|---|---|
| V1 | Control generation, clean, end to end | Cheapest possible discovery of a broken happy path |
| V2 | **7.6 add-section has never run against a live model** | Covered only by unit tests and mock-mode e2e |
| V3 | **7.9 page regeneration has never run against a live model** | Same |
| V4 | **Fan-out-subprocess resume is unverified** | The Kitaru experiment was single-process |

The justification for putting this class first is this project's own history,
which is unusually consistent: **every first live run has found multiple real
bugs that mock mode and a green suite could not see.** 5.5's first end-to-end
run found five. 6.4's handover trials found five more, all in code that
compiled cleanly. 7.1 found that section regeneration could not run at all for
19 of 20 archetypes. Three features currently sit in exactly the state those
did the day before they were run.

### Rounds 2+ — ranked, not yet detailed

| # | Item | Rank rationale |
|---|---|---|
| H1 | Orphaned orchestrator **grandchild** on preview-child kill: it finishes, spends, and writes a usage log nobody ingests (`docs/decisions.md`, 2026-08-09) | Real money, and the cleanup watchdog made it the *normal* path at the default grace rather than a rare one. Bounded at ~one regen per occurrence, and occurrences are rare with no users — which is the only reason it is not first |
| H2 | The **fifth `..`** — a systematic audit of every place a client- or model-influenced string reaches a path, a URL, or a spawn argument | Four traversal defects at four layers, each caught by a different mechanism, one in a rail written during this project. Cheap, and finds unknowns rather than confirming knowns |
| H3 | Six concurrent proxied jobs can consume the whole preview pool, so job traffic can 503 a user's live preview | Only bites under load that does not exist |
| H4 | `runOnce()` is uncapped and bypasses `MAX_CONCURRENT_JOBS` | Latent: no production caller today. A trap for the next one |
| H5 | The `job` table has no retention path; rows accumulate forever | Per-row size and queued count are both bounded; only total history is not |
| H6 | Thread `--out-dir` through the orchestrator so `--projects-root` is genuinely honoured | Currently mitigated by a refuse-to-boot. The real fix touches `GENERATED_DIR` in ~20 modules and needs a live run to verify — best done *after* round 1 has a live harness standing |
| H7 | Docs corrections: `CLAUDE.md`'s two stale claims; the job-model spec's "the pool's cap of 6 does double duty" sentence, false for `generate` | Cheap, and the first is actively misleading |

### Deferred while nobody has access

| # | Item | Why deferred |
|---|---|---|
| D1 | **Accepted risk 1** — same-origin preview removed the iframe sandbox; generated code is model-authored from a free-text brief, so a prompt injection could exfiltrate the stored API key over the user's own session. A 5-step cross-origin migration is already written down | With one operator who is also the only author of every brief, this collapses to self-attack. It becomes the **top item the moment anyone else gets an account**, and must be re-ranked then |
| D2 | **Accepted risk 3** — preview children run as the same OS user and can read each other's directories | Same reasoning |
| D3 | The UI slice: production static serving, a login page, project selection | The hosted server serves no HTML at all (verified: zero `text/html` in `server/`). Everything slices 2–5 built is unreachable except through the editor's dev-server proxy. Not needed while the operator is the only user |

**D1 and D3 are coupled and the coupling is the point:** D3 is what makes the
system reachable by other people, and D1 is what must be true before other
people are safe to invite. They ship together or not at all.

## Decisions taken in brainstorming

| # | Decision | Rejected | Why |
|---|---|---|---|
| 1 | **No deployment on the horizon; hardening leads** | Inviting users soon; demo/portfolio | Demotes the isolation work (D1/D2) and the UI slice (D3), and promotes correctness |
| 2 | **Features never proven live are the top class** | Silent money loss; the `..` audit; operational fragility | This project's live-first runs have a 100% hit rate for finding real bugs |
| 3 | **~$6 authorised**, covering all three verifications plus a clean control run | ~$0.60 for the cheap two; $0 | Buys the fan-out resume experiment, which needs a real generation induced to fail, plus headroom for one retry |
| 4 | **Fix what the live run proves broken; stop and escalate anything structural** | Open-ended "fix everything"; verify-only; blockers-only | Matches how 5.5 and 6.4 actually went — mostly small template/contract fixes, occasionally something deep enough to deserve its own decision |
| 5 | **Round 1 is detailed now; rounds 2+ are ranked only** | Specifying the whole hardening list up front | Round 1's findings reorder what follows |
| 6 | **Drive every verification through the hosted HTTP path**, inducing the fault by killing the real orchestrator process tree | Layer-matched (orchestrator CLIs); a gated fault-injection env var | Every expensive bug this project has found lived at a seam, and the CLI path skips the seams. Fault injection would put test-only code in a production path, which this codebase has consistently refused |

## Round 1 design

### Why the fault must land on the orchestrator, not the server

`POST /api/jobs/:id/resume` requires `original.status === "failed"`
(`server/src/job-routes.ts:348`), and a `generate` job reaches `failed` only
when `orchestrator.acceptance` exits non-zero. Killing the **server** mid-run
produces `interrupted`, which is deliberately never retried and is not
resumable. So the resume experiment cannot be staged by restarting the server —
the fault has to hit the `uv run python` tree itself.

Killing that tree is also the most faithful available fault: it is a real crash
with real partial checkpoints, not a simulation. It needs no production code
change. On Windows the kill must target the **whole tree** (`taskkill /T`),
because page workers are subprocesses and killing only the parent leaves them
running — which is itself the shape of pending item H1, so this step may
produce free evidence about it.

### Setup

One `server/scripts/serve.ts` instance, one operator-created user (via
`user-cli.ts` — still the only thing that creates a user), one real Anthropic
key stored through the BYOK path, `WEBGEN_MASTER_KEY` set. Every request goes
over HTTP as a logged-in user. No test seams, no direct function calls.

### The four runs, in cheapest-failure-first order

**V1 — Control generation (~$1.10).**
A clean `POST /api/generate` with a 3-page brief, polled to `succeeded`.

Proves: the happy path still works after slice 5's concurrency and shutdown
changes. Re-measures cost and wall clock.

The wall-clock comparison must **account for shape, not just raw seconds.**
`m7-wall-clock.md`'s 286s baseline was 4 routes / 8 sections; slice 5's live run
was 401.8s for 10 sections across 3 routes. Fewer routes means fewer parallel
workers and more sections serialized per worker, and that report's own finding
(a ~149s sequential prelude plus ~13s/section of contention, with per-section
model latency only 27s) predicts exactly that direction. A number that differs
from 286s is not by itself a regression; a number that differs from what the
prelude-plus-contention model predicts for *this* shape is.

Runs first because a broken happy path invalidates everything downstream, and
discovering it here costs the least.

**V2 — 7.6 add-section, live (~$0.12).**
`POST /__add-section` against the site V1 just produced.

Proves: a real model generates a valid new section; it appends to the source and
is positioned by a `sectionOrder` override; the site plan mutates correctly; all
seven gates pass at export. This is a **first generation, not a replay** — the
section never existed — which is the specific thing mock mode cannot exercise.

**V3 — 7.9 page regeneration, live (~$0.40).**
`POST /__regen-page` against one route of the same site.

Proves: the sequential loop over the section path works against a real model,
each section is regenerated rather than one file being rewritten N times (mock
regen once hardcoded `Hero`, which would have reported six sections done while
rewriting one file six times), and **one revert restores the whole page** from
the single route-wide snapshot taken before the first section.

**V4 — Fan-out-subprocess resume (~$1.10 + a cheap resume).**
`POST /api/generate`; once the run log shows fan-out under way with at least one
section recorded, kill the orchestrator process tree; confirm the job lands
`failed`; `POST /api/jobs/:id/resume`.

Proves, and each is a separate assertion:
- the resumed job reuses the original `run_id`;
- completed checkpoints are **replayed, not re-executed** — no new
  `section.generated` events for sections that already finished;
- only the incomplete work runs again;
- the resume's ingested cost is far below the first attempt's, which is the
  economic signature of a real replay and the check that cannot be faked by a
  log line;
- `page_worker.py`'s `progress.json` skip behaves as expected across the
  subprocess boundary.

This is the one with genuine doubt. The Kitaru experiment behind the resume
feature was **single-process**, and the mitigation that makes the real exposure
small (`page_worker.py` skipping already-recorded sections *before* invoking the
flow) is file-based and holds regardless of the cache — so the two mechanisms
are independent, and only a real multi-process run shows which one is carrying
the weight. Kitaru is pinned at **0.21.0** in `orchestrator/uv.lock`; the
finding is valid for that version and the report must say so.

### Budget

~$2.72 expected against a ~$6 ceiling, leaving room for one retry or one extra
diagnostic run. **Every run's actual cost is read from `usage_event`, not
estimated**, and the report states the real total.

### Pass/fail and what gets written down

Each run reports verbatim: what was asked, what happened, actual cost from
`usage_event`, wall clock, and every assertion with its result. **A verification
that does not behave as expected is reported as a finding, not smoothed over** —
including anything that merely looked odd.

Findings are triaged per decision 4: proven-broken gets fixed in this round;
anything needing a redesign stops the round and comes back to the human with the
evidence. The round's output is `docs/reports/` plus one `docs/decisions.md` row
per call the docs do not already cover.

### What round 1 does not do

- **No fix for H1 (the orphaned grandchild)**, even though V4's kill step may
  produce evidence about it. Fixing it means propagating termination through the
  Vite child, which is `compiler/` territory and a separate decision.
- **No `--out-dir` threading (H6)**, though V1 gives the live harness that its
  eventual verification needs.
- **No docs corrections (H7)** unless separately approved — see "The record,
  corrected".
- **No production code changed to make a verification easier.** If a
  verification cannot be run without a production change, that is a finding
  about the design, and it gets reported rather than worked around.
- **Nothing from D1–D3.**

## Risks

1. **A live run may find something structural**, which by decision 4 halts the
   round. This is the intended behaviour, not a failure — but it means the
   round's end date is genuinely unknown. 7.1 is the precedent: what looked like
   a wiring gap was a Kitaru substitution rule that broke 19 of 20 archetypes.
2. **V4's kill may not produce a clean `failed`.** If the tree dies in a way
   that leaves the job `running` or `interrupted` instead, resume is unreachable
   and the experiment needs a different fault. That outcome is itself a finding
   worth having — it would mean a real orchestrator crash in production is not
   resumable either, which is precisely what the feature claims to handle.
3. **Cost overrun** if a run retries internally. Bounded by the spend cap and by
   reading actual spend from `usage_event` after every run rather than at the
   end.
4. **The existing generated site may go stale as a fallback.** V2 and V3 run
   against V1's fresh output; `generated/web-8b3af163-…` (3 routes, 10 sections,
   from slice 5's live run) remains available as a fallback if V1 fails and the
   round continues under a narrowed scope.

## After round 1

Re-rank H1–H7 with round 1's findings in hand, then plan the next round. D1–D3
stay deferred until the access decision changes — and **decision 1 is the
assumption to re-examine first**, because the entire ranking above inverts the
moment a second person gets an account.
