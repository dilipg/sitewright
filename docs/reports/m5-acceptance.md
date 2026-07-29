# Milestone 5 full-pipeline acceptance — measurement report

Build prompt 5.5: run docs/build-plan-v1.md's milestone 5 exit criteria end to end — one-line brief → plan approval → full generation → edit across all channels → section regen → export — and measure against the "Definition of v1 done" performance table.

## Method

No end-to-end orchestration entry point existed anywhere in the codebase before this milestone: every pipeline stage (`plan`, `design`, `shell`, `fanout`) was a separate, independently human-invoked CLI, chained by hand (copy a `run_id` between commands, edit `plan-status.json` in an editor session to approve). New `orchestrator/src/orchestrator/acceptance.py` chains all five stages — plan → approve → design → shell → fan-out → export — in one Python process, timing each stage and aggregating real dollar cost from the run log via a new `orchestrator/src/orchestrator/pricing.py` (also new: no dollar-cost calculator existed before this milestone either — every prior measurement compared tokens to a token budget, never converted to dollars). Both are offline-unit-tested; `acceptance.py` itself is not, since every stage it drives makes real, billed Anthropic API calls (this project's standing convention: pytest stays offline, CI has no API key).

Per the user's explicit sequencing choice: build the glue, prove it once cheaply, fix whatever broke, and only then commit to the full 3-run acceptance exactly as `docs/build-prompts-v1.md` 5.5 specifies.

The proof pass (a single-page brief, run twice) surfaced and fixed two genuine, previously-undiscovered generation-quality bugs in the `generic-section` template (the fallback used for any of the 20-archetype catalog beyond the 6 with dedicated templates) — see decisions.md for the full account. The subsequent first full 3-page acceptance run surfaced three more, of increasing severity, the last a real crash bug in production code (not a prompt gap) that could silently drop every remaining section on a route. All five are fixed and covered by the offline test suite where the fix was code, not prompt text. Full account, root-cause reasoning, and the alternatives considered for each: `docs/decisions.md`, 2026-07-29 rows.

Three consecutive full acceptance runs were then completed, each a genuinely different one-line brief spanning the marketing/storefront/SaaS archetype sets this project targets, each producing a real 3-page site (a landing page plus two brief-requested secondary pages) through the complete pipeline including export.

## Result: generation cost and wall clock

| Run | Brief | Pages | Sections | Cost | Wall clock |
|---|---|---|---|---|---|
| 1 | Northline (SaaS analytics) | home, pricing, about | 13 | **$1.69** | **650.0 s** (10 m 50 s) |
| 2 | Wildflower Supply Co. (storefront) | home, shop, contact | 12 | **$1.83** | **546.8 s** (9 m 7 s) |
| 3 | Anchor Legal (marketing) | home, about, contact | 12 | **$1.73** | **574.4 s** (9 m 34 s) |

| Metric | Target | Ceiling | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|---|
| Model cost | < $10 | $15 | ✅ $1.69 | ✅ $1.83 | ✅ $1.73 |
| Wall clock | < 5 min | 10 min | ❌ 10 m 50 s (**over ceiling**) | ⚠️ 9 m 7 s (over target, under ceiling) | ⚠️ 9 m 34 s (over target, under ceiling) |

**Cost: 3/3 comfortably inside both target and ceiling**, with wide headroom (~83% under target). Total tokens per run (232k–241k) are well under the 930k full-site budget even accounting for these being 3-page, not 6-page, sites — see the extrapolation note below.

**Wall clock: 0/3 inside the 5-minute target; 2/3 inside the 10-minute ceiling; 1/3 (run 1) breached the ceiling.** Per-stage breakdown is consistent across all three runs: `plan` ~15–22 s, `design` ~70–130 s, `shell` ~13–21 s, `export` ~3 s — fan-out is the dominant cost every time (376–528 s, 65–81% of total wall clock). Fan-out parallelizes across routes (separate OS processes per route, confirmed by `fanout.py`'s own architecture), so total wall clock is bounded by the *slowest* route's sequential section count, not the sum of all routes — consistent with all three runs' `home`/other-route durations landing within roughly 30% of each other rather than summing.

**Root cause of the wall-clock miss:** the target's own stated assumption is "page fan-out must be truly parallel (6 pages × ~5 sections sequential per page ≈ 5 × section latency, so section latency must stay under ~55 s including gates)." Measured section latency in these runs (fan-out duration ÷ sections per route, folding in the retry attempts each run needed) runs closer to 90–130 s — roughly 1.6–2.4× the ~55 s budget the target assumes. This tracks with per-call output volume: Sonnet calls in these runs averaged ~3,800–4,300 output tokens each. Prompt caching is confirmed active and substantial (`cache_read_input_tokens` in the tens of thousands per run) — the miss is not prompt bloat, it's real per-call generation time for genuinely verbose, production-quality section output.

**Decision on remediation (asked directly, mid-milestone):** report this finding honestly rather than force a "3/3 inside ceilings" claim that isn't true, and do not apply a remediation lever within this milestone. The documented levers (compress DESIGN CONTEXT, shrink archetype examples, prompt-cache the system+context prefix, tier archetypes down to a faster model) are aimed at token/cost, and the cost budget already has enormous headroom — cutting tokens further wouldn't move wall clock much. The one lever that *would* directly cut wall clock — tiering page-section generation from Sonnet to a faster model — is a real content-quality tradeoff, not a mechanical fix, and out of scope for this human to authorize unilaterally mid-report. Flagged here as a genuine, measured gap for a future milestone decision, per this project's standing rule to flag rather than silently paper over.

**6-page extrapolation, with an important asymmetry:** every acceptance run here generated a 3-page site (a landing page + 2 brief-requested pages), not the full 6-page scenario the performance table targets — cost per section is stable, so a 6-page site's cost extrapolates linearly to roughly $3–3.5, still comfortably under the $10 target. Wall clock does **not** extrapolate the same way: because routes run in true parallel, a 6-page site's wall clock is governed by whichever single route has the most sections, not by total page count — a 6-page site could measure similarly to these 3-page runs, or worse, depending on the planner's per-route section counts. This measurement cannot resolve that without an actual 6-page run, which was not performed (see Scope below).

## Result: edit across all channels + section regen

Exercised against `acceptance-run-1d` (the Northline SaaS proof-pass project, since retained on disk) rather than re-running the full invariant suite against fresh content: the override-compilation *mechanism* is already proven exhaustively (28 cases × 4 channels × 6 archetypes against the fixture, milestone 5.4; ID survival specifically proven at 100% across 71 varied regen instructions, milestone 4). What 5.5 needs to newly prove is that the same mechanism holds against genuinely LLM-generated (not hand-authored) content and measure the regen round-trip on it — so overrides were written directly via the preview server's `PUT /__overrides/<route>` API (the same mechanism the editor's own persistence layer uses) rather than through browser automation.

One override per channel, on real nodes from the live-generated Hero section:

| Channel | Node | Override | Result |
|---|---|---|---|
| text | `home.hero.headline` | new headline copy | ✅ compiled into `mock/Hero.data.ts` |
| style | `home.hero.eyebrow` | accent color token | ✅ compiled into `Hero.tsx`'s className |
| layout | `home.hero.cta-primary` | margin-top token | ✅ compiled into `Hero.tsx`'s className |
| visibility | `home.hero.subheadline` | hidden | ✅ element tombstoned out of the export |

All four confirmed by direct inspection of the exported source (`generated/acceptance-run-1d-edit-export/`) — preview/override state matched export output exactly, on a real generated project.

**Regen round-trip:** `orchestrator.regenerate --section home.hero` with a real content-changing instruction ("make the hero's tone more energetic, emphasize speed and real-time insight"). Result: **79.4 s** wall clock (64 s inside Kitaru's own flow-execution accounting; the remainder is process/CLI startup) — over the 60 s target, under the 90 s ceiling. Took 3 attempts (2 gate-failure retries) to pass, consistent with this run's overall retry pattern. **All 4 overridden node IDs survived the regeneration with zero orphans** (`orphanedOverrides: []`), reconfirming milestone 4's ID-survival guarantee against a genuinely regenerated section on a real project, not just the fixture. A final export after the regen confirmed the site still built cleanly with all 4 overrides intact.

| Metric | Target | Ceiling | Measured |
|---|---|---|---|
| Section regen round-trip | < 60 s | 90 s | ⚠️ 79.4 s (over target, under ceiling) |

Same pattern as generation wall clock: consistently over target, within ceiling, driven by the same per-call latency dynamics. No separate remediation attempted here, per the same reporting decision above.

**Single edit gesture feedback (<100 ms target / 250 ms ceiling)** was not separately instrumented with a timer in this milestone. The mechanism is architecturally exempt from network latency by construction — an edit gesture updates local React state and posts a message to the preview iframe; the debounced *persistence* write (a separate, already-tested 300 ms-debounced network round trip) is decoupled from the visual feedback the metric describes. The existing editor e2e suite already exercises every edit channel functionally (does the visual state update correctly), just not with a stopwatch on the gesture-to-repaint interval specifically. Flagged here as measured-by-architecture rather than measured-by-instrument, to keep this report honest about what was and wasn't actually timed.

## Bugs found and fixed this milestone

Discovered only because this was the first time any of these code paths had ever been exercised end-to-end, live, against real generated content. Full root-cause writeups: `docs/decisions.md`, 2026-07-29 rows.

1. **Contract 5.6 (new)**: a section's `<SectionName>Props` interface must never declare `nodeId` (it comes from a separate `NodeProps` intersection) — the `generic-section` template never said so explicitly, so the model folded it in directly, producing a duplicate-prop TypeScript error caught only at export's production build.
2. **Contract 4.1 (amended)**: primitives are default exports — `generic-section.md` never said so, so the model emitted named imports against default-only modules for two uncatalogued SaaS archetypes, another export-time-only TypeScript failure.
3. **`FailedSectionPlaceholder` no longer carries a `nodeId`** — the first time a section ever genuinely exhausted its 3 retry attempts in a live run revealed that its placeholder's `data-node-id` had no manifest entry (nothing was ever successfully proposed), correctly tripping gate 4's whole-project check. Fixed by dropping the id, matching the existing precedent that deterministic, non-agent-authored content (the design-system gallery page) stays outside manifest jurisdiction.
4. **`generic-section.md` gained a concrete list-item node-id code snippet** — the root cause of #3: a section with ~8 repeated items failed gate 4 on every one of ~30 proposed nodes, on all 3 attempts, because the template taught the list-item id-attachment convention in prose only, unlike every dedicated list-based archetype (which teaches it via a full worked example).
5. **Defensive fix, most severe**: `write_section_only`'s bare `data["sectionMeta"]` raised an unhandled `KeyError` when the model's structured output omitted `sectionMeta` entirely — crashing the whole page-worker process and silently dropping every remaining section queued behind it, bypassing the retry loop and the `FailedSectionPlaceholder` fallback entirely. New `validate_section_meta()` applies the same "checked result, not exception" defensive-accessor pattern this codebase had already applied to a different required field (`manifestProposals`, `proposals_of()`) after an earlier live incident — now consistently applied to both.

All five are now covered where the fix was code (offline pytest, `orchestrator/tests/test_section_pipeline.py`); the prompt-template fixes (#1, #2, #4) are covered by the fact that all three full acceptance runs completed cleanly after they were applied, with zero recurrence of any of the three failure modes across 3 runs × 12–13 sections each.

## Scope and deviations

- **3-page sites, not 6-page.** Matches milestone 5's exit criteria ("4-to-6-page marketing site") at the low end, not the high end — chosen deliberately to bound real LLM spend across what became 4 proof/debug attempts plus 3 full acceptance runs (7 live pipeline executions total this milestone, on top of the regen call). See the 6-page extrapolation note above for why this matters more for wall clock than for cost.
- **Edit+regen exercised via direct override-API writes, not browser automation.** The override-compilation mechanism itself is already exhaustively proven (28-case invariant suite, milestone 5.4; ID survival, milestone 4) — this milestone's job was to prove it against real generated content and measure timing, which the API-level approach does directly and far more cheaply than driving a full Playwright session through the canvas UI for content that was going to be typed into the same override files either way.
- **No remediation attempted for the wall-clock/regen-timing findings**, per explicit sign-off mid-report (see above) — both are reported as genuine, measured gaps rather than resolved.

## VERIFY line

`docs/build-prompts-v1.md` 5.5: *"3 consecutive full runs inside ceilings; invariant suite green."*

- **3 consecutive full runs**: completed. **Inside ceilings**: cost 3/3; wall clock 2/3 (run 1 breached the wall-clock ceiling); regen round-trip 1/1 measured, inside ceiling. Reported precisely rather than rounded up to a clean pass — see the wall-clock section above.
- **Invariant suite green**: reconfirmed live via a full `npm run check` at the end of this milestone (not just asserted from unchanged surface) — 312/312 across every package: compiler vitest 86/86, editor vitest 55/55, orchestrator pytest 87/87 (84 pre-existing + 3 new for `validate_section_meta`), compiler e2e 13/13, editor e2e 71/71 (the full 28-case invariant matrix included). Zero regressions from this milestone's changes.
