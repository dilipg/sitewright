# Incremental Build Prompts v1

How to use this playbook:

- One prompt = one Claude Code session (or one `/clear`). Paste the prompt verbatim; each is self-contained and tells the session what to read.
- Do not advance to the next prompt until the current prompt's VERIFY block passes. The prompts assume all prior work is green.
- Commit after every prompt with the given message prefix. If a session ends with failing tests, fix in the same session or revert; never carry red across prompts.
- Prompts P0 to P2 set up the workspace. Milestone prompts are numbered to match `build-plan-v1.md`.
- When a prompt says "the docs," it means: `docs/codegen-contract-v1.md`, `docs/agent-pipeline-spec-v1.md`, `docs/canvas-editor-prd-v1.md`, `docs/build-plan-v1.md`. The contract always wins conflicts.

---

## Setup

### P0 — Repo bootstrap

```
Read docs/build-plan-v1.md section 0 (build philosophy and repo shape) and skim the other three docs in docs/.

Scaffold the monorepo exactly per the repo shape: orchestrator/ (Python 3.12, uv, pytest), editor/ (Vite + React + TypeScript), compiler/ (TypeScript library with vitest, consumed by editor and CLI), prompts/ (empty archetypes/ dir), fixtures/ (empty), generated/ (gitignored). Add root tooling: one command (`make check` or npm script + uv script) that runs every test suite in the repo. Add CI config (GitHub Actions) running that command.

Do not implement any product logic. Placeholder tests only, proving each package's test runner works.

VERIFY: `make check` (or equivalent) passes locally; CI config is valid.
COMMIT: "chore(P0): monorepo scaffold"
```

### P1 — CLAUDE.md

```
Read all four docs in docs/ fully.

Write CLAUDE.md at the repo root for future Claude Code sessions. It must contain: (1) one-paragraph product summary; (2) the doc hierarchy and the rule that codegen-contract-v1.md wins all conflicts; (3) the ownership map from contract section 2 as hard rules for which package writes which paths; (4) the build philosophy rules from build-plan section 0 (walking skeleton, risk before breadth, deterministic before generative); (5) test/verify commands; (6) the rule: never modify docs/ to make code pass; flag doc problems to the human instead.

VERIFY: CLAUDE.md is under 150 lines and contains no information that contradicts the docs.
COMMIT: "chore(P1): CLAUDE.md"
```

### P2 — Decision log

```
Create docs/decisions.md with a 5-column table (date, decision, alternatives considered, reason, prompted-by) seeded with the decisions already made in the docs: DOM-canvas over raw Canvas API, override layer over live code patching, Kitaru over hand-rolled runtime, no reviewer agent in v1, sequential sections within parallel pages. Future sessions append here when they make a call the docs don't cover.

VERIFY: file exists, seeded rows accurate to the docs.
COMMIT: "chore(P2): decision log"
```

---

## Milestone 1 — The contract in code, no LLMs

### 1.1 — Fixture project

```
Read docs/codegen-contract-v1.md fully (this prompt implements its sections 2 to 5 by hand).

Hand-write fixtures/acme-landing/: a complete project tree per contract section 2 for a fictional one-page product. Include: tokens.json per schema 3.1; four primitives (Button, Heading, Text, Container) per contract 4.1 with nodeId passthrough and className merge; shell/ with AppShell, Nav, Footer, routes.ts (single "/" route); pages/home/ with one hero section per contract 4.3 (props interface, mock data file, zero hardcoded user-visible strings); data-node-id attributes per contract 5.1 and 5.2; a correct manifest.json per 5.4; an empty overrides/home.overrides.json.

This fixture is the permanent ground truth for every compiler and editor test. Favor clarity over cleverness. The fixture must build: give it a minimal vite config and make `npm run build` inside the fixture pass.

VERIFY: fixture builds; every selectable element has a data-node-id present in manifest.json; grep confirms no hex colors or raw px outside tokens/.
COMMIT: "feat(1.1): hand-written fixture project"
```

### 1.2 — Token deriver

```
Read docs/codegen-contract-v1.md section 3.

In compiler/, implement deriveTokens(tokensJson) → { tokensCss, tailwindTheme }: resolves ref: values, emits CSS custom properties (naming: --color-semantic-accent, --space-4, per the contract's examples), and a Tailwind theme mapping. Pure function, deterministic output ordering.

Tests: snapshot test against fixtures/acme-landing/src/tokens/tokens.json; unit tests for ref resolution, circular ref detection (must throw with a clear message), and unknown-ref failure. Replace the fixture's hand-written tokens.css with derived output and confirm the fixture still builds identically.

VERIFY: all tests green; fixture builds with derived tokens.css.
COMMIT: "feat(1.2): token deriver"
```

### 1.3 — Manifest service

```
Read docs/codegen-contract-v1.md sections 5.2 to 5.4.

In compiler/, implement the manifest service: propose(entries[]) → validation result; commit(proposals) → new manifest; tombstone(nodeIds[]). Validation enforces: ID format (route.section.element-path, semantic slugs), uniqueness against active entries, file paths within the proposing agent's ownership boundary (ownership map passed as config), editable-channel values from the closed set, and tombstone rules (tombstoned IDs may never be re-registered with a different file/component).

Tests: valid proposal round-trip against the fixture manifest; rejection cases for each rule (duplicate ID, positional-looking ID like child-3, out-of-boundary path, unknown channel, resurrection of a tombstone).

VERIFY: all tests green.
COMMIT: "feat(1.3): manifest service"
```

### 1.4 — Validation gates

```
Read docs/codegen-contract-v1.md section 8 (gates 1 to 6; gate 7 comes in milestone 4).

In compiler/, implement gates 1 to 6 as a runGates(projectDir, ownershipMap) function plus a CLI (`gates <dir>`). Gate output is a structured report: gate id, pass/fail, and for failures a machine-readable reason plus a human/LLM-readable message (this exact message later gets injected into retry prompts, per pipeline 5.4, so make it specific and actionable).

Create fixtures/broken/ containing one minimal variant per gate failure: unresolvable import, dangling href, raw hex in a section, missing/duplicate data-node-id, hardcoded user-visible string in JSX, cross-page import. Tests: clean fixture passes all gates; each broken variant fails exactly its gate.

VERIFY: all tests green; CLI works on the fixture.
COMMIT: "feat(1.4): validation gates 1-6"
```

### 1.5 — Exporter core

```
Read docs/codegen-contract-v1.md sections 6 and 7.

In compiler/, implement exportProject(projectDir) per contract section 7 steps 1 to 4: text channel rewrites mock-data literals (locate via manifest file+component mapping, use AST rewriting via ts-morph or similar, never regex on source); style/layout channels compile token refs to classes merged last into className; visibility removes JSX and tombstones; then typecheck + gates + production build of the output. Export writes to a new directory, never in place. Failed export = non-zero exit + report, no partial output directory left behind.

Tests: identity export (zero overrides) produces a building project whose rendered output is unchanged; one test per channel using hand-written overrides against the fixture; export is idempotent (exporting the export with no overrides = no diff); failed-build export leaves no output dir.

VERIFY: all tests green. Run the full spine: derive tokens → gates → export → build, one command, green on fixture.
COMMIT: "feat(1.5): exporter core — milestone 1 complete"
```

---

## Milestone 2 — Preview, shim, one edit channel

### 2.1 — Preview server + bridge shim

```
Read docs/canvas-editor-prd-v1.md section 2.2 and docs/codegen-contract-v1.md section 6.2.

Implement the bridge shim as a Vite plugin (dev-only injection, stripped from builds): geometry indexing and reporting (ResizeObserver + MutationObserver, batched per animation frame), overrides:apply for all four channels via injected style sheet + content substitution, mode:set (edit mode suppresses navigation/submission; interact mode restores it), node:hit forwarding, frame:ready handshake with protocol version. Define the postMessage protocol as typed messages in compiler/ (shared package) with a PROTOCOL_VERSION constant.

Test with a headless harness (Playwright): load the fixture with shim, assert geometry report completeness against manifest, apply a style override and assert computed style, apply text override and assert content, toggle modes and assert a link click does/doesn't navigate.

VERIFY: Playwright suite green.
COMMIT: "feat(2.1): preview server + bridge shim"
```

### 2.2 — Editor skeleton + selection

```
Read docs/canvas-editor-prd-v1.md sections 2.1, 2.3 (single frame only for now, per build-plan stubbing table).

In editor/: app shell hosting one iframe (the fixture preview), overlay layer in the parent document rendering hover outline + human-readable node label and selection handles from geometry reports. Click-to-select deepest node, Esc walks up ancestry, breadcrumb shows element → section → page. Manifest is loaded to drive selectability and the editable channel set of the selection (render as inert badges for now).

VERIFY: Playwright: click hero headline → selected with correct breadcrumb; Esc selects hero section; unaddressable element click selects nearest addressable ancestor.
COMMIT: "feat(2.2): editor skeleton + selection"
```

### 2.3 — Style channel + persistence + undo

```
Read docs/canvas-editor-prd-v1.md sections 3.2 and 6, docs/codegen-contract-v1.md section 6.1.

Implement the inspector panel for the style channel: semantic-token color swatches, typography token steppers, spacing steppers with the visual spacing overlay, variant switcher for primitives. Every commit writes a contract-6.1 override entry to the store; store autosaves (debounced) to overrides/<route>.overrides.json via a small local file-API server; live application through overrides:apply. Single persisted undo/redo stack. Free-value escape one level deep, off-scale badge per PRD.

VERIFY: Playwright: change hero background via swatch → visible <100ms; reload → edit persists; undo → reverted visually and in file; off-scale custom value shows badge.
COMMIT: "feat(2.3): style channel editing"
```

### 2.4 — Invariant test

```
Read docs/canvas-editor-prd-v1.md section 7.1.

Build the invariant suite: for a scripted set of style-channel edits, drive the editor (Playwright), screenshot the edited preview node, run exportProject, build and serve the export, screenshot the same node (located by data-node-id in dev, by deterministic selector mapping in the export), pixel-diff with a small threshold. Wire into CI as a required check. Structure it so milestone 5 can extend it to all channels and archetypes by adding cases, not code.

VERIFY: suite green; deliberately breaking the exporter's class merge order makes it fail.
COMMIT: "feat(2.4): preview=export invariant suite — milestone 2 complete"
```

---

## Milestone 3 — One agent, for real

### 3.1 — Orchestrator + Kitaru

```
Read docs/agent-pipeline-spec-v1.md sections 5.1 to 5.3, and Kitaru's docs (https://docs.zenml.io/kitaru — fetch and read the quickstart, checkpoints, and replay-and-overrides guides).

In orchestrator/: Kitaru-instrumented service skeleton. Wrap our Anthropic API call as a checkpointed step (use the maintained adapter if it fits, else the documented custom-step path). Implement checkpointed file-write steps that fully replace a section's files (idempotence per pipeline 5.3). Stand up a single-step demo pipeline: canned prompt → model call → write file → checkpoint; kill it mid-run and prove resume skips the completed model call.

Config: model tiering table from pipeline section 3 as config, prompt caching enabled, per-call token accounting recorded.

VERIFY: demo pipeline runs; forced-crash resume does not re-bill the completed model call (assert via recorded token counts); run state inspectable.
COMMIT: "feat(3.1): orchestrator + Kitaru runtime"
```

### 3.2 — Prompt assembly + hero template + run log

```
Read docs/agent-pipeline-spec-v1.md sections 4.1, 4.2 (hero only), and 7.

Implement the template engine: block assembly per 4.1 anatomy from prompts/archetypes/*.md with {{placeholders}}, template versioning (content hash + semver in frontmatter), and rendered-prompt recording. Write prompts/archetypes/hero.md: system block digest of contract rules, archetype guidance, one canonical few-shot example that itself passes all gates (build it from the fixture's hero). Compact DESIGN CONTEXT builder: token summary + primitive signatures under 600 tokens, unit-tested for size.

Run log v1 per build-plan stub table: JSONL (rendered prompt hash + stored prompt, template version, model, params, token counts, gate results, checkpoint refs) plus a single-page HTML viewer.

VERIFY: rendering the hero template with fixture context produces a prompt whose blocks are all present and whose DESIGN CONTEXT is <600 tokens; run log viewer displays a fake run.
COMMIT: "feat(3.2): prompt assembly + hero archetype + run log"
```

### 3.3 — Single-section generation

```
Read docs/agent-pipeline-spec-v1.md sections 2.5 and 5.4, docs/codegen-contract-v1.md sections 4.3 and 5.

Wire the full single-section path: render hero prompt (canned brief, fixture tokens/primitives/shell as context) → model call with structured output (files + manifest proposals + section metadata) → write files into generated/<run>/pages/home/ → manifest service propose → gates → on failure, bounded retry (max 2) replaying with the gate failure report appended per pipeline 5.4 → manifest commit at section.validated. Checkpoints exactly per pipeline 5.2.

VERIFY: one real run end to end produces a hero that passes gates; artificially inject a gate-failing instruction into the prompt and confirm the retry path executes with the failure report in the retry prompt (visible in run log) and the manifest holds no garbage from the failed attempt.
COMMIT: "feat(3.3): single-section generation with gated retry"
```

### 3.4 — Skeleton soak

```
Run the walking-skeleton acceptance from docs/build-plan-v1.md milestone 3 exit criteria:

Execute 10 generation runs with 10 distinct canned briefs (write them: varied products, tones, audiences). For each: gates pass within retry budget; open the result in the editor; apply one style edit; export; invariant diff passes. Record per-run cost.

Produce docs/reports/m3-soak.md: per-run outcome table, retry counts, token costs vs the 25k/section budget, cached vs uncached split, and the three worst outputs with one-line diagnosis each (template fix? context fix? sampling?).

VERIFY: ≥9/10 runs fully green; mean section cost ≤ 2× budget. If not met, iterate on the hero template (not the infrastructure) in this session until met, appending template changes to docs/decisions.md.
COMMIT: "test(3.4): walking skeleton soak — milestone 3 complete"
```

---

## Milestone 4 — Regeneration + ID survival

### 4.1 — Regen path

```
Read docs/agent-pipeline-spec-v1.md section 5.5, docs/codegen-contract-v1.md section 5.3, and gate 7 in section 8.

Implement: regenerateSection(runId, route, section, userInstruction) forking the recorded run at the section checkpoint via Kitaru replay-with-overrides, REGEN BLOCK populated (old source, section manifest entries, overridden node ID list, instruction). Implement gate 7: every previously-overridden ID present in output or declared in orphanedOverrides structured field; violation = gate failure = standard retry path. Manifest updates + tombstones on success.

VERIFY: regen a soaked run's hero with "change the headline tone to playful" → overridden IDs survive; regen with "remove the subheadline" against a run with a subheadline text override → orphanedOverrides contains exactly that ID.
COMMIT: "feat(4.1): section regeneration + gate 7"
```

### 4.2 — Regen UX

```
Read docs/canvas-editor-prd-v1.md section 4 (items 1 to 5).

Editor: section-level selection affordance, Regenerate button opening instruction box pre-filled with the section's planner brief (canned brief for now), cost estimate display, in-place progress while the rest stays editable, on-success re-render with surviving overrides applied, orphaned-override dialog (discard / copy value), revert-regeneration (checkpoint fork back, presented in one history line with the undo stack).

VERIFY: Playwright: full regen round-trip incl. orphan dialog and revert; overrides on surviving nodes visibly re-applied without user action.
COMMIT: "feat(4.2): regeneration UX"
```

### 4.3 — ID-survival stress suite

```
Read docs/build-plan-v1.md milestone 4 exit criteria and standing risk 1.

Build the scripted stress suite: 20 regen instructions (write them: rewordings, structural changes, element removals, count changes, tone shifts) against hero sections carrying overrides on 3+ nodes each. Measure: auto-reattach rate on conceptually-surviving elements, orphan correctness (no silent drops — assert override count in = reattached + orphaned), gate-7 retry rate.

Produce docs/reports/m4-id-survival.md with the numbers. If reattach <90%: iterate template REGEN BLOCK wording first; if still short, STOP and report to the human with the data — the two-phase fallback (build-plan risk 1) is a human decision, do not implement it unilaterally.

VERIFY: ≥90% reattach, zero silent drops. This is a hard gate on the whole project.
COMMIT: "test(4.3): ID survival proven — milestone 4 complete"
```

---

## Milestone 5 — Full pipeline, narrow catalog

### 5.1 — Intake + Planner + approval

```
Read docs/agent-pipeline-spec-v1.md sections 2.1, 2.2, 4.3.

Implement Intake Agent (brief.json schema, one clarifying round max, assumptions recorded) and Site Planner (siteplan.json, catalog-only archetypes + custom budget rule, landing + marketing page archetype priors). Editor gains the plan-approval screen: route list, per-route section list with archetype labels, editable briefs, approve button gating generation spend. Both agents mid-tier models per pipeline section 3.

VERIFY: 5 varied briefs → plausible plans (human eyeball + structural assertions: hero first and cta-band last on landing, 4-7 sections, all archetypes from catalog); thin brief triggers exactly one clarification round.
COMMIT: "feat(5.1): intake + planner + plan approval"
```

### 5.2 — Design System Agent

```
Read docs/agent-pipeline-spec-v1.md section 2.3, docs/codegen-contract-v1.md sections 3 and 4.1.

Implement the two-step Design System Agent (tokens, then the full 15-primitive set) with per-step checkpoints. Primitive generation runs against static internal per-primitive specs (write these: props shape, variant unions, nodeId/className rules). Generated tokens flow through the milestone-1 deriver; generated primitives must pass gates and typecheck.

Then re-point the pipeline: generated tokens/primitives replace fixture context in page-agent prompts (fixture remains the compiler test bed, per build-plan stub table).

VERIFY: 5 briefs → 5 visually distinct, gate-passing design systems (render a primitive gallery page per run for eyeball review); hero generation still soaks green against generated systems. If primitive quality is visibly below the fixture's, record it in decisions.md and raise build-plan risk 3 with the human rather than shipping worse primitives silently.
COMMIT: "feat(5.2): design system agent"
```

### 5.3 — Shell Agent + fan-out

```
Read docs/agent-pipeline-spec-v1.md sections 2.4, 2.5, 5.3.

Implement the Shell Agent (shell/, routes.ts ground truth). Implement page fan-out: one worker per route in parallel, sequential sections within a page with prior-section summaries in context, per-page assembly step, all checkpoints per pipeline 5.2. Crash test: kill -9 a page worker mid-section, resume, assert no duplicate spend and no manifest garbage.

VERIFY: a 4-page plan generates in parallel; crash-resume test green; gate 6 (ownership) never trips across 5 runs.
COMMIT: "feat(5.3): shell agent + parallel page fan-out"
```

### 5.4 — Catalog to six + remaining channels + canvas

```
Read docs/agent-pipeline-spec-v1.md section 4.2 (skeleton cut), docs/canvas-editor-prd-v1.md sections 2.1, 3.1, 3.3, 3.4, and 8 (risks 1, 2).

Three workstreams, do them in this order:
1. Archetype templates for feature-grid, cta-band, pricing-tiers, faq-accordion, social-proof, each with a gate-passing canonical example; soak each with 5 runs before moving on.
2. Editor: text channel (inline contentEditable per PRD 3.1), layout channel (drag/resize with token snapping, no reparenting, rejected-gesture hint per PRD risk 3), visibility channel.
3. Infinite canvas: pan/zoom stage, one frame per route, virtualization (live frames near viewport, screenshots beyond, per PRD risk 2).

Extend the invariant suite to all four channels × all six archetypes.

VERIFY: invariant suite green across the full matrix; 60fps pan/zoom on a 6-page generated site (measure, don't guess).
COMMIT: "feat(5.4): six archetypes + all P0 channels + infinite canvas"
```

### 5.5 — Full-site acceptance

```
Run docs/build-plan-v1.md milestone 5 exit criteria end to end: one-line brief → plan approval → full generation → edit across all channels → section regen → export.

Measure against the performance table in build-plan "Definition of v1 done": cost (target <$10, ceiling $15), wall clock (target <5min, ceiling 10), regen round-trip (target <60s, ceiling 90). If over target but under ceiling, apply pipeline section 6 levers in order and re-measure. Produce docs/reports/m5-acceptance.md.

VERIFY: 3 consecutive full runs inside ceilings; invariant suite green.
COMMIT: "test(5.5): full pipeline acceptance — milestone 5 complete"
```

---

## Milestone 6 — Hardening + handover quality

### 6.1 — Full catalog

```
Read docs/agent-pipeline-spec-v1.md section 4.2 (remaining 14 archetypes) and docs/codegen-contract-v1.md section 4.3.

Add the storefront and SaaS archetype sets + storefront/saas-product page archetypes. For every interactive archetype (cart-drawer, contact-form, product-detail buy box...): handler props typed in the interface, mock no-ops with TODO: integrate comments — audit the whole catalog for this. Soak each new archetype 5 runs. Extend invariant suite cases.

VERIFY: soaks green; a storefront brief generates a plausible store; grep audit: every onSubmit/onClick-style prop across generated soak output traces to a typed handler prop, zero inline business logic.
COMMIT: "feat(6.1): full 20-archetype catalog"
```

### 6.2 — Export handover

```
Read docs/canvas-editor-prd-v1.md section 5, docs/codegen-contract-v1.md section 7 (step 5 stays off by default).

Implement: HANDOVER.md generation (props/mock seam map, integration TODO list from handler props, off-scale override list), zip packaging, file-tree preview in the editor, export-repeatability (archive overrides, editable state preserved). Loud failure UI with gate report.

VERIFY: export a soaked storefront; HANDOVER.md accurately lists every TODO seam (cross-check against 6.1's grep audit); double export = identical zips (modulo timestamps).
COMMIT: "feat(6.2): export handover package"
```

### 6.3 — Failure surface + DAG viewer

```
Read docs/agent-pipeline-spec-v1.md sections 7 and 8.

Write one automated (or scripted-manual, documented in docs/reports/m6-failure-drill.md) test per row of the section-8 failure table, including: failed-section placeholder rendering in preview, orphan dialog, export abort. Upgrade the run log to the DAG timeline viewer: per-node status/cost, drill-down to rendered prompt and raw output.

VERIFY: every failure-table row demonstrably handled; DAG viewer renders a full m5 run.
COMMIT: "feat(6.3): failure hardening + DAG run viewer"
```

### 6.4 — Handover trial

```
Read docs/build-plan-v1.md milestone 6 exit criteria.

Export a generated storefront. In a FRESH Claude Code session with no repo context (only the export zip), execute the task: "wire the cart to a fake REST API (json-server), using only the export and its HANDOVER.md." Log every friction point: unclear seam, hardcoded value, component needing rewrite, HANDOVER.md gap.

Bring findings back: file each friction point as either an archetype-template fix or a HANDOVER.md generator fix, implement the fixes, re-run the trial once.

VERIFY: second trial completes with zero component rewrites. Produce docs/reports/m6-handover-trial.md.
COMMIT: "test(6.4): developer handover trial — milestone 6 complete"
```

---

## Milestone 7 — P1 pull list

```
No fixed prompts. Read docs/canvas-editor-prd-v1.md section 7 P1 row and docs/build-plan-v1.md milestone 7. Pull items by observed need — check docs/reports/ and the rejected-gesture log first. For each pulled item, write a mini-prompt in this file's format (goal, read-first, verify, commit) before implementing, and append it under this section so the playbook stays the single sequence of record.

Candidates in likely order: add-a-section (PRD 4.1), section reorder (PRD 3.3 sectionOrder override), image replace (PRD 3.5), responsive read-only preview, page-level regen.
```

### Pull order (set 2026-07-30, by observed need)

Correctness before features, per the milestone-7 instruction to pull by observed
need rather than list order. Items 1-4 come from docs/reports/ and decisions.md;
items 5-9 are the PRD P1 list itself.

1. **7.1 Regen for list-based archetypes** - regen is the PRD's differentiating
   loop and it could not run at all for 19 of 20 archetypes (6.4).
2. **7.2 Cross-route gate scoping** - gates 2/3/5/6 still scan the whole project
   during parallel fan-out; a sibling's in-flight files fail an innocent worker
   and burn its retry budget (6.1; gate 1 was scoped in 6.4).
3. **7.3 Wall clock** - 5.5 missed the 5-minute target on 0/3 runs; 6.3 added the
   per-call latency data that makes it diagnosable, unexamined so far.
4. **7.4 Handover P0s** - the four two-trial-evidenced items from 6.4.
5. 7.5 Section reorder (PRD 3.3) - the rejected-gesture log exists precisely to
   signal this.
6. 7.6 Add-a-section (PRD 4.1).
7. 7.7 Image replace (PRD 3.5).
8. 7.8 Responsive read-only preview.
9. 7.9 Page-level regen.

### 7.1 - Regen for list-based archetypes

```
Read docs/reports/m6-handover-trial.md and the 2026-07-30 decisions rows on the
Kitaru replay failure.

Section regeneration dies before it starts for any section whose stored prompt
contains `${identifier}`: Kitaru runs replayed values through zenml's
substitute_env_variable_placeholders (pattern \$\{([a-zA-Z0-9_]+)\},
raise_when_missing=True), and contract 5.2 REQUIRES `${nodeId}` in list-item
ids. 19 of 20 archetype templates contain the pattern; `hero` is the only one
that does not, and it is the only section M4's ID-survival suite and 5.5's regen
check ever exercised.

Fix it, and check the assumption that the exec being replayed is the right one.

VERIFY: a live regen of a LIST-BASED section changes what the instruction asked
for, every list-item id survives, and the template-literal id pattern is intact.
COMMIT: "fix(7.1): section regeneration works for list-based archetypes"
```

### 7.2 - Cross-route gate scoping

```
Read the 2026-07-30 decisions row on the cross-route gate-scoping gap, and
gateNodeIdsRegistered's own doc comment in compiler/src/gates.ts.

Only gate 4 (since 5.3) and gate 1's typecheck (6.4) honour scopeRoute. Gates
1, 2, 3, 5 and 6's static check still scan the whole project even when scoped,
so during parallel fan-out a page worker fails on a SIBLING's half-written
route and burns its own retry budget on a problem it cannot fix.

Extend the same containment to them. Containment must not become blindness:
a scoped run must still catch every one of its OWN problems.

VERIFY: per gate, breaking route B leaves an A-scoped run clean, still fails a
B-scoped run, and still fails the unscoped whole-project run.
COMMIT: "fix(7.2): scope gates 1/2/3/5/6 to the route under generation"
```

### 7.3 - Wall clock: look at the data

```
Read docs/reports/m5-acceptance.md's wall-clock section.

5.5 measured wall clock as the failing metric and attributed it to per-section
model latency running 1.6-2.4x the docs' ~55s/section assumption -- an
inference, because completion-only timestamps cannot separate model time from
per-section overhead. 6.3 added duration_s specifically so the claim could be
checked. Check it before optimising anything.

VERIFY: docs/reports/m7-wall-clock.md states measured per-section latency, where
the wall clock actually goes, and orders the optimisation levers by evidence.
COMMIT: "docs(7.3): wall-clock diagnosis - the model was never the bottleneck"
```

---

## Standing rules for every session

1. Never edit docs/ to make code pass; escalate conflicts to the human via a clear report.
2. Every non-doc decision the docs don't cover → one row in docs/decisions.md.
3. Red tests never cross a commit boundary.
4. Generated output is disposable; fixtures and tests are not. When a generation-quality problem appears, fix the template or the contract enforcement, never hand-patch generated files.
5. Token spend on soaks is real money: soaks use the budget in pipeline section 6 as the alarm threshold and stop early if a run exceeds 3× its stage budget.
