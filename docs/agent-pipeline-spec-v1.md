# Agent Pipeline Spec v1

Status: Draft for review
Depends on: `codegen-contract-v1.md` (the contract). Nothing in this spec may violate the contract; where they appear to conflict, the contract wins.
Scope: orchestration DAG, agent definitions, parameterized prompt templates, token budget, Kitaru runtime integration, failure handling.

---

## 1. Pipeline overview

```
User brief
   │
   ▼
[0] Intake Agent ──────────────► brief.json (normalized)
   │
   ▼
[1] Site Planner ──────────────► siteplan.json (routes, page archetypes, section lists)
   │
   ▼
[2] Design System Agent ───────► tokens/, primitives/          (serial)
   │
   ▼
[3] Shell Agent ───────────────► shell/, routes.ts             (serial)
   │
   ▼
[4] Page Agents ×N ────────────► pages/<slug>/                 (parallel, fan-out)
   │        each page = sequential section generations
   ▼
[5] Validation Gates ──────────► pass / bounded retry           (per section, mechanical)
   │
   ▼
[6] Assembly ──────────────────► build + preview bundle         (mechanical)
```

Stages 0 to 3 are serial because everything downstream consumes their outputs read-only. Stage 4 fans out one agent per route with zero shared writes (ownership rules, contract section 2). Stages 5 and 6 are deterministic code, not LLM calls.

---

## 2. Agent definitions

### 2.1 Intake Agent

Purpose: turn a freeform vibe prompt into a structured brief so every downstream prompt consumes the same normalized fields, never the raw user text.

Output `brief.json`:

```json
{
  "siteType": "landing | marketing | storefront | saas-product",
  "brand": { "name": "", "tone": "", "audience": "", "oneLiner": "" },
  "creativity": "low",
  "contentHints": ["..."],
  "pagesRequested": ["..."] ,
  "constraints": ["..."]
}
```

`creativity` is hardcoded `low` in v1 (contract 3.2). The field exists so the schema does not change when the slider ships.

If the brief is too thin to plan a site (no product name, no purpose), the Intake Agent asks the user at most one round of clarifying questions before proceeding with stated assumptions. Assumptions are recorded in `brief.json.assumptions` and shown in the UI.

### 2.2 Site Planner

Purpose: decide the route map and, per route, pick a page archetype and a section list drawn from the section archetype catalog (section 4).

Output `siteplan.json`:

```json
{
  "routes": [
    {
      "slug": "home",
      "path": "/",
      "pageArchetype": "landing",
      "title": "Home",
      "sections": [
        { "slug": "hero", "archetype": "hero", "brief": "one sentence of intent" },
        { "slug": "features", "archetype": "feature-grid", "brief": "..." },
        { "slug": "cta", "archetype": "cta-band", "brief": "..." }
      ]
    }
  ]
}
```

Hard rule: the Planner may only use archetypes from the catalog. A need that fits no archetype maps to `custom` (section 4.4), which is allowed but budgeted, so the Planner is prompted to prefer catalog archetypes.

The plan is shown to the user for approval before generation spend begins. This is the cheapest correction point in the whole system.

### 2.3 Design System Agent

Reads `brief.json`. Writes `tokens/` and `primitives/` (sole owner). Runs once.

Two internal steps, one checkpoint each:

1. Token generation: emits `tokens.json` per contract 3.1. Deterministic derivation code (not the LLM) produces `tokens.css` and the Tailwind theme mapping.
2. Primitive generation: emits the fixed v1 primitive set (contract 4.1). Primitives are generated against a static internal spec per primitive (props interface shape, variant unions, nodeId passthrough), so this is closer to constrained fill-in than open generation.

### 2.4 Shell Agent

Reads `brief.json`, `siteplan.json`, tokens, primitive inventory. Writes `shell/` (sole owner). Emits `routes.ts` as the ground-truth route table. Nav and footer link only to planned routes.

### 2.5 Page Agents (fan-out)

One agent instance per route. Reads (all read-only): normalized brief, its route entry from the site plan, token summary, primitive inventory, route table, and the archetype templates for its sections. Writes only `pages/<slug>/`.

Internal loop, strictly sequential within a page:

```
for each section in route.sections:
    render prompt from archetype template     (section 4)
    generate section component + mock data    → checkpoint
    run validation gates                      → checkpoint
    on gate failure: bounded retry (max 2) from section checkpoint
write index.tsx assembling sections           → checkpoint
emit manifest entry proposals (structured)    → manifest service validates and commits
```

Sections within a page are sequential so each section prompt can include a one-paragraph summary of the sections already generated on that page (prevents a page whose hero and CTA say different things). Pages are parallel to each other; cross-page consistency is carried entirely by tokens, primitives, and shell, by design.

### 2.6 What deliberately does not exist in v1

No reviewer agent, no reconciliation agent, no critic loops. Consistency is enforced by constraint (ownership, tokens, gates), which is the token-conservative architecture. Slot for a review pass is reserved between stages 5 and 6 if quality data ever justifies it.

---

## 3. Model tiering

| Role | Tier | Rationale |
|---|---|---|
| Intake, Site Planner | mid | structured output, judgment-light |
| Design System Agent | top | quality here multiplies across every page |
| Shell Agent | mid | constrained, template-like |
| Page Agents | top | the visible product |
| Gate-failure retry prompts | same as original | changing models mid-retry confounds debugging |
| Export cleanup pass (off by default) | small | cosmetic |

---

## 4. Prompt architecture: parameterized archetype templates

### 4.1 Template anatomy

Every section prompt is assembled from fixed blocks. Nothing is freeform-generated by an orchestrator LLM; "dynamic" means parameter substitution plus context injection, which keeps prompts loggable, diffable, and replayable.

```
[SYSTEM BLOCK]        static per release: role, contract rules digest,
                      output format (structured), forbidden moves
                      (raw hex, cross-page imports, hardcoded strings...)

[DESIGN CONTEXT]      token summary + primitive inventory signatures
                      (compact form, not full source: ~600 tokens)

[PAGE CONTEXT]        route entry, page brief, summaries of prior
                      sections on this page, route table

[ARCHETYPE BLOCK]     static per archetype: structural guidance, quality
                      bar, common failure modes to avoid, 1 short
                      canonical example (few-shot)

[SECTION BRIEF]       the planner's one-line intent + relevant
                      contentHints from brief.json

[REGEN BLOCK]         empty on first run; on regeneration carries old
                      source, manifest entries, overridden node IDs,
                      and the user's modification instruction
```

Template files are versioned in the repo (`prompts/archetypes/<name>.md` with `{{placeholders}}`). A generation run records the template version + rendered prompt hash per section into the run log, so any bad output is attributable to either template, context, or model sampling.

### 4.2 Section archetype catalog v1

Marketing/landing set: `hero`, `feature-grid`, `feature-spotlight` (alternating media rows), `social-proof` (logos/testimonials), `pricing-tiers`, `faq-accordion`, `cta-band`, `stats-band`, `team-grid`, `contact-form`.

Storefront set: `product-card-grid`, `product-detail` (gallery + buy box), `collection-header`, `cart-drawer`, `category-nav`.

SaaS set: `integration-grid`, `comparison-table`, `changelog-list`, `docs-toc-page`.

Twenty archetypes total. Each ships with its template, a props-shape hint, and one canonical example. Growing this catalog is the main ongoing content work of the product; treat archetype quality as a first-class backlog.

### 4.3 Page archetypes

`landing`, `marketing-page`, `storefront`, `saas-product`. A page archetype is just a Planner-side prior: preferred section sequences and count ranges (landing: 4 to 7 sections, hero first, cta-band last). It adds no prompt blocks of its own.

### 4.4 The `custom` archetype

A fallback template with structural guidance only ("compose primitives, respect tokens, output shape X") and no canonical example. Budget: max 1 custom section per page in v1. Every custom generation is logged as a signal for which archetype to build next.

---

## 5. Kitaru integration

### 5.1 Topology

The orchestrator is a Python service; each pipeline stage runs as Kitaru-instrumented steps. Model calls and file-write tool calls are recorded as durable checkpoints. The Claude API is called through the adapter layer; if the maintained adapters don't cover our client, we wrap our model-call function as a marked checkpoint step, which is the documented extension path.

### 5.2 Checkpoint map

| Checkpoint | Granularity | Why |
|---|---|---|
| intake.complete | once | cheap, but anchors replay of everything |
| plan.complete | once | user-approved artifact, natural resume point |
| tokens.complete / primitives.complete | once each | most expensive single artifacts |
| page.<slug>.section.<slug>.generated | per section | the unit of retry and regeneration |
| page.<slug>.section.<slug>.validated | per section | separates "model failed" from "gate failed" in the record |
| page.<slug>.assembled | per page | resume point for crashed fan-out workers |

Rule of thumb: checkpoint after every model call whose re-execution costs more than ~10k tokens, and after every state transition the UI reports.

### 5.3 Crash recovery

A crashed or OOM-killed page worker resumes from its last section checkpoint. File writes are idempotent by contract (a section rewrite fully replaces its own files, never appends), so replaying a section that half-wrote is safe. The manifest service is transactional: proposals commit only at `section.validated`, so a crash between generation and validation leaves no manifest garbage.

### 5.4 Bad-output recovery (the common case)

A checkpoint does not fix an agent that deterministically produces bad output. Gate failures therefore always modify the input before retry: the retry replays from `section.generated`'s parent with the gate's failure report appended to the prompt (replay-with-overrides, changed input = changed output). Max 2 retries, then the section is marked `failed` and surfaced in the UI with its failure report; the rest of the site continues. A failed section renders as a labeled placeholder in preview rather than blocking the page.

### 5.5 Section regeneration (the flagship replay feature)

User selects a section in the editor and types a modification ("make this pricing section three tiers instead of four"). The orchestrator forks the recorded run at that section's checkpoint with the REGEN BLOCK populated (old source, manifest entries, overridden node IDs, user instruction) and re-executes only that section: generation, gates, manifest update, orphaned-override report. Cost of a regen ≈ cost of one section, never one page or one site. This path is the hand-rolled piece of runtime work (everything else is stock Kitaru) and the contract's ID-survival rules (5.3) exist to serve it.

---

## 6. Token budget (v1 targets, 6-page site)

| Stage | Calls | Budget (in+out) |
|---|---|---|
| Intake | 1 | 3k |
| Site Planner | 1 | 6k |
| Design System | 2 | 30k |
| Shell | 1 | 15k |
| Page Agents | ~30 sections | 25k × 30 = 750k |
| Retries (assume 15% gate-failure rate) | ~5 | 125k |
| **Total** | | **≈ 930k tokens** |

Levers if this proves too high, in order of preference: compress the DESIGN CONTEXT block (biggest repeated cost, appears in every section call), shrink archetype examples, prompt-cache the SYSTEM + DESIGN CONTEXT prefix (identical across all sections of a run, largest single saving), tier some archetypes down to a mid model. The budget assumes prompt caching is enabled from day one; without it, input-token spend roughly doubles.

Per-section regen ≈ 30k tokens, which is what makes iterative editing economically fine.

---

## 7. Run log and observability

Every run persists: rendered prompts (hashed + stored), template versions, model + params per call, gate results with failure reports, per-stage token counts, checkpoint tree. Minimum viable debugging view: a run timeline showing the DAG with per-node status, cost, and drill-down to the exact rendered prompt and raw output. Without this view, dynamic-context prompts are undebuggable; build it in week one, not last.

---

## 8. Failure surface summary

| Failure | Handling |
|---|---|
| Thin brief | one clarifying round, then proceed with recorded assumptions |
| Planner picks bad structure | user approves plan before spend |
| Gate failure | bounded retry with failure report injected (5.4) |
| Section fails twice | placeholder + surfaced report; site continues |
| Worker crash | resume from section checkpoint (5.3) |
| Manifest conflict | manifest service rejects; treated as gate failure |
| Regen removes overridden element | orphanedOverrides surfaced to user (contract 5.3) |
| Export build failure | export aborts loudly (contract 7.4) |
