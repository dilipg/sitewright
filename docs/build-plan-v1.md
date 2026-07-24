# Build Plan v1

Status: Draft for review
Depends on: `codegen-contract-v1.md`, `agent-pipeline-spec-v1.md`, `canvas-editor-prd-v1.md`.
Audience: Claude Code (and you, supervising). This is the execution order, what to stub, and what "done" means at each milestone. Assumes one developer driving Claude Code, roughly 10 weeks to a usable v1.

---

## 0. Build philosophy

Three rules govern the ordering:

1. **Walking skeleton first.** One route, one archetype, one edit channel, real export, all wired end to end before any breadth. Every integration risk in this system lives at the seams (agent → manifest → shim → override → exporter), and the skeleton forces every seam to exist by week 3.
2. **Risk before breadth.** The three things that can invalidate the architecture are node-ID survival across regeneration, preview/export fidelity, and prompt-cache economics. Each gets proven inside the skeleton, not deferred to polish.
3. **Deterministic before generative.** Every mechanical component (manifest service, gates, exporter, shim) is built and tested against hand-written fixture code before any LLM generates its input. Debugging generated code through untested infrastructure means two unknowns per bug.

Repo shape: a monorepo with `orchestrator/` (Python, Kitaru), `editor/` (web app), `compiler/` (manifest service, gates, exporter; TypeScript, shared with editor), `prompts/` (versioned templates), `fixtures/` (hand-written sample project conforming to the contract), and `generated/<project-id>/` as the output workspace.

---

## Milestone 1: The contract in code, no LLMs (week 1)

Build the deterministic spine against a hand-written fixture project.

Deliverables:

- **Fixture project**: a hand-authored `project/` tree per contract section 2: tokens.json, 4 primitives (Button, Heading, Text, Container), one `home` route with one `hero` section, mock data, node IDs, manifest.json. This fixture is the ground truth for every test in the system; write it carefully.
- **Token deriver**: tokens.json → tokens.css + Tailwind mapping, deterministic, snapshot-tested.
- **Manifest service**: propose/validate/commit/tombstone API with uniqueness, format, and ownership checks. Unit-tested against malformed proposals.
- **Validation gates 1 to 6** (contract section 8) as a CLI runnable against the fixture; seed the test suite with deliberately broken fixture variants (raw hex, dangling href, duplicate ID, hardcoded string, cross-page import).
- **Exporter core**: override JSON + fixture → compiled source (all four channels), then typecheck + build. Include the export of a fixture with zero overrides (identity export) and with each channel exercised.

Exit criteria: `compile → gate → export → build` runs green on the fixture from one command. Gate suite fails correctly on every broken variant.

## Milestone 2: Preview + shim + one edit channel (week 2)

- Vite dev server serving the fixture project with the bridge shim injected.
- Editor app skeleton: single frame (no infinite canvas yet), overlay layer, selection via `node:hit`, geometry overlays via `nodes:geometry`.
- **Style channel only**: token-swatch color picker + spacing steppers writing override entries; live application through `overrides:apply`; persistence; undo.
- **The invariant test, first version** (PRD 7.1): apply a style override, export, build, screenshot-diff exported page vs edited preview. Wire into CI now.

Exit criteria: edit the fixture hero's background and padding in the browser, reload (edits persist), export, and the screenshot diff passes. This is the moment the core product claim (preview = handover) is proven, on hand-written code.

## Milestone 3: One agent, for real (week 3)

Introduce the first LLM into a system that can already validate its output.

- Orchestrator service with Kitaru integrated; single-step pipeline: one Page Agent generating one `hero` section into a copy of the fixture project (tokens, primitives, shell all still hand-written fixture).
- The `hero` archetype template, fully assembled per pipeline section 4.1, with prompt logging and template versioning from day one (pipeline section 7's run log, minimal version: JSONL + a dumb HTML viewer).
- Structured-output parsing → manifest proposals → gates → bounded retry with failure-report injection (pipeline 5.4).
- Prompt caching enabled; record per-call cached/uncached token counts.

Exit criteria: 10 consecutive runs with distinct briefs produce hero sections that pass all gates within the retry budget; each run's rendered prompt, output, cost, and checkpoint tree visible in the run log. Token cost per section within 2× of the 25k budget.

**Walking skeleton is complete here.** Brief → generated hero → canvas edit → export, end to end. Everything after this is breadth and depth on a proven loop.

## Milestone 4: Regeneration + ID survival (week 4)

The highest-risk architectural claim gets proven before breadth.

- Section regeneration via Kitaru replay-with-overrides: REGEN BLOCK population (old source, manifest entries, overridden IDs, user instruction), gate 7 (ID survival / orphanedOverrides), manifest tombstoning.
- Editor: section selection, regenerate prompt box, in-place progress, orphaned-override dialog, revert-regeneration.
- **ID-survival stress test**: scripted suite of 20 regen instructions against overridden hero sections (reword, restructure, remove elements, change counts), measuring override survival rate and orphan correctness.

Exit criteria: ≥ 90% of overrides on conceptually-surviving elements reattach automatically across the stress suite; zero silent drops (every non-surviving override appears in the orphan dialog). If this can't be reached by prompt + gate iteration, stop and redesign the ID scheme before proceeding; nothing downstream is worth building on unstable IDs.

## Milestone 5: Full pipeline, narrow catalog (weeks 5 to 6)

- Intake Agent, Site Planner (with user plan-approval UI), Design System Agent (replacing fixture tokens/primitives; full 15-primitive set), Shell Agent.
- Page fan-out with parallel workers, per-page sequential sections, crash-resume from checkpoints (kill -9 a worker mid-run as a test).
- Archetype catalog cut for the skeleton phase: `hero`, `feature-grid`, `cta-band`, `pricing-tiers`, `faq-accordion`, `social-proof` (6 of 20). Landing + marketing page archetypes only.
- Editor: infinite canvas with multiple frames, frame virtualization, remaining P0 edit channels (text, layout, visibility).

Exit criteria: a one-line brief produces a complete 4-to-6-page marketing site, editable across all P0 channels, exportable, with total cost within 1.5× of the 930k budget. Invariant suite green across all channels and all 6 archetypes.

## Milestone 6: Hardening + handover quality (weeks 7 to 8)

- Remaining 14 archetypes (storefront + SaaS sets), storefront and saas-product page archetypes, mock-data seams with handler props and TODO comments audited across the catalog.
- `HANDOVER.md` generation; export zip; identity-export idempotence tests.
- Failure-surface pass: every row of pipeline section 8's table exercised by an automated or scripted manual test; failed-section placeholder rendering; thin-brief clarification round.
- Run-log viewer upgraded to the DAG timeline (pipeline section 7).
- **Developer-handover trial**: give an exported storefront to a real frontend developer (or a fresh Claude Code session with no project context) with the task "wire the cart to a fake API." Measure friction; every hardcoded string, unclear seam, or thrown-away component found here is a P0 archetype-template bug.

Exit criteria: handover trial completes without the developer rewriting any generated component; all failure-surface rows pass.

## Milestone 7: Polish + P1s (weeks 9 to 10)

Pull from the PRD P1 list by observed need, not by list order: add-a-section, section reorder, image replace, responsive read-only preview, page-level regen. Budget deliberately underfilled; weeks 9 to 10 will absorb slippage from milestones 4 to 6, and that's the plan working, not failing.

---

## Stubbing strategy (what fakes what, and when the fake dies)

| Stub | Used during | Replaced in |
|---|---|---|
| Fixture project (hand-written) | M1 to M3 | M5 (generated tokens/primitives/shell) |
| Fixture tokens + primitives in agent context | M3, M4 | M5 |
| Canned briefs (no Intake/Planner) | M3, M4 | M5 |
| Single frame (no infinite canvas) | M2 to M4 | M5 |
| JSONL + HTML run log | M3 to M5 | M6 (DAG viewer) |
| Screenshot-diff on fixture only | M2 | M5 (all archetypes) |

The fixture project never fully dies: it remains the permanent test bed for compiler/ and shim changes, because it's stable while generated output varies.

## Standing risks and tripwires

1. **ID survival below target at M4**: the stop-the-line risk. Fallback design if prompting can't hit 90%: two-phase regen (agent emits a structural diff plan naming preserved IDs, a second constrained call executes it). Costlier, more reliable.
2. **Token budget blows past 1.5× at M5**: pull the levers in pipeline section 6 in order; if still over, tier feature-grid/faq/social-proof down to the mid model before touching hero/pricing.
3. **Design System Agent quality (M5)**: if generated primitives are visibly worse than the fixture's, ship v1 with 3 to 5 hand-tuned primitive "families" the agent parameterizes via tokens rather than fully generating. This is a quality decision, not an architecture change; the contract is unchanged.
4. **Vite frame weight (M5)**: virtualization is specced; if still heavy, fall back to one live frame (focused route) + static screenshots for the rest.

## Definition of v1 done

A stranger can: type a brief, approve a plan, watch a site generate, edit text/style/layout/visibility on a canvas, regenerate a section without losing edits, and export a zip that builds, matches the preview pixel-for-pixel on edited nodes, and gets accepted by a developer without rewrites.

Performance targets, benchmarked against industry norms (Lovable and Bolt anchor at $25/month plans where a full iterated site build consumes roughly $5 to $15 of allowance; major builders complete initial generation in under 5 minutes; iteration round-trips run well under 2 minutes):

| Metric | Target | Hard ceiling |
|---|---|---|
| Model cost per 6-page site | < $10 | $15 |
| Full-site generation wall clock | < 5 min | 10 min |
| Section regen round-trip | < 60 s | 90 s |
| Single edit gesture feedback | < 100 ms | 250 ms |

Targets are what we tune toward; ceilings are release blockers. The 5-minute generation target implies page fan-out must be truly parallel (6 pages × ~5 sections sequential per page ≈ 5 × section latency, so section latency must stay under ~55 s including gates).
