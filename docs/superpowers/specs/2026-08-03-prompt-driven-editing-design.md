# Prompt-driven editing — design

**Date:** 2026-08-03
**Status:** approved, ready for implementation planning
**Slice:** 1 of 5 (see *Decomposition* below)

## Goal

Let the user change a generated site by describing the change instead of
selecting nodes and filling in controls.

> "make the hero headline shorter and the primary button green"

The instruction compiles to the **same override operations the canvas already
produces**. Nothing about persistence, undo/redo, the shim, or the exporter
changes; the prompt is a second way to author overrides, not a second kind of
edit.

## Decomposition

The original request — login, per-user API keys, prompt-driven generation,
per-user isolation, prompt-driven editing — is five independent subsystems.
Each gets its own spec → plan → implementation cycle:

| # | Slice | Status |
|---|---|---|
| 1 | **Prompt-driven editing** | this spec |
| 2 | Accounts (username/password, sessions) | not started |
| 3 | BYOK secrets (user-supplied API key) | not started |
| 4 | Tenancy & isolation (authz on every API) | not started |
| 5 | Web-triggered generation | not started |

The agreed destination is a **hosted, multi-user web app**. This slice runs
single-user on the current local architecture, but is designed as a stateless
`{route, instruction}` request so it moves to that destination without redesign.

## Scope

**In:** a prompt surface in the editor that produces override operations across
the five existing channels (text, style, layout, visibility, sectionOrder);
target resolution by the agent; detection of structural requests and routing
them to the existing regeneration flows behind a cost confirmation.

**Out:** authentication, multi-tenancy, BYOK, web-triggered generation,
structural *generation* (this slice routes to what already exists rather than
reimplementing it), and multi-route prompts — one route at a time.

## Decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Whole-page prompt; the agent resolves targets | Select-then-prompt | Selection-first is still a click-first workflow. Selection remains *supported* and narrows context when present, but is never required. |
| Compile to override channels only | Regenerate sections per prompt | An override is deterministic, free, instantly reversible, and preserves preview = handover. Regeneration is ~100× the cost and can rewrite content the user never mentioned. |
| Structural asks detected and routed, with a cost confirmation | Silently regenerate; or refuse outright | Silent regeneration spends money without consent. Refusing walls off a common intent ("add a testimonials section"). |
| Apply immediately, show a per-item-undoable summary | Propose a diff and wait for approval | Overrides are free and reversible; the cost of a wrong target is one click. A confirm step on every edit defeats the point. |
| One model path (no deterministic fast path) | Local grammar matcher for common phrasings | At ~$0.001 cached the saving does not justify two code paths that can diverge. This project has already been bitten once by a mock path that behaved differently from the real one. |
| Haiku 4.5, escalating to Sonnet 5 once on failure | Sonnet always; or Haiku only | Resolving an instruction to `{node, channel, token}` is lookup and mapping, not authoring — the design system supplies the values. Escalation covers genuinely hard instructions without paying Sonnet for the common case. |
| Agent returns operations; the **editor** applies them | Agent writes override files directly | The ownership map gives override files exactly one writer. Returning operations keeps that true and inherits validation, persistence, undo/redo and export for free. |
| All-or-nothing per prompt | Apply the valid operations, skip the invalid | A compound instruction that half-lands is worse than one that cleanly did not, and it keeps "one prompt = one undo entry" honest. |

## Architecture

```
editor: prompt box
   │  POST /__edit-prompt { route, instruction, selection? }
   ▼
preview server (compiler/src/regen-api.ts)
   │  spawn, same plumbing as /__regen
   ▼
orchestrator/src/orchestrator/edit_agent.py
   │  builds a projection of the route + token vocabulary
   │  one structured tool call (Haiku 4.5 → Sonnet 5 on failure)
   ▼  returns typed operations
editor validates every operation against the manifest
   │
   ├─ all valid  → apply via existing store functions
   │               (applyTextValue / applyStyleProperty / applyLayoutProperty /
   │                applyVisibility / moveSection)
   │               ONE pushHistory entry for the whole prompt
   │
   └─ any invalid → nothing applied; rejection reported
```

Three additions. No new writer of override files, no change to the override
file format, no change to the exporter.

## Agent contract

### Response

Exactly one of `operations`, `clarify` or `structural` is present — the agent
either edits, asks, or defers to a paid flow. `notes` is always present.

```jsonc
// edits
{ "operations": [ /* see below */ ], "notes": "Shortened the headline and recoloured the CTA." }

// asks
{ "clarify": "which button — 'Start free trial' or 'Book a demo'?", "notes": "Two buttons matched." }

// defers
{ "structural": { "kind": "add-section",      // | "regenerate-section" | "regenerate-page"
                  "route": "home",
                  "archetype": "social-proof",
                  "reason": "adding a section requires generation" },
  "notes": "This needs a new section generated." }
```

### Operations

| op | fields | notes |
|---|---|---|
| `text` | `nodeId`, `value`, `key?` | `key: "src"` is image replace (PRD 3.5) |
| `style` | `nodeId`, `property`, `token` | `token` is an **enum of this project's own token paths** |
| `styleExact` | `nodeId`, `property`, `value` | off-scale; only when the user asked for an exact value |
| `layout` | `nodeId`, `property`, `value` | size/position deltas only (contract 6.1) |
| `visibility` | `nodeId`, `hidden` | |
| `sectionOrder` | `route`, `order[]` | must list every section on the route (7.5) |

### Input, and the token budget

**Cached prefix** (identical across every prompt in a session):

- system prompt and the tool schema
- the project's token vocabulary — the valid token *paths*, not `tokens.json` wholesale
- a projection of the route: per node its id, element, editable channels, and
  current text truncated to ~80 characters. Non-editable nodes are omitted.
  Style values are included only when the instruction mentions style.

**Variable:** the instruction, and the selected node id when there is one.

A selection narrows **both** the projection and the permitted targets: with a
node selected, the agent sees only that subtree and may only emit operations
within it. This is what makes selection worth having — it removes ambiguity
rather than merely hinting at it — and it is why the whole-page path must work
without one.

Estimated ~2,200 input / ~150 output tokens for a 40-node route.

| | uncached | cached prefix |
|---|---|---|
| Sonnet 5 | ~$0.009 | ~$0.003 |
| **Haiku 4.5** | ~$0.003 | **~$0.001** |

A section regeneration is ~30k tokens ≈ $0.13, so a prompt edit is roughly
**1/100th of a regeneration**. These are estimates: `pricing.py` is wired in
from the first commit so the real figure is measured. This project has already
had one assumed performance figure overturned by measurement (7.3).

## UI fidelity

Nothing stops a model emitting `#39ff14` or `marginTop: "37px"`, and the
override layer *permits* both — that is what the exporter already counts as
"off-scale overrides" in HANDOVER.md. Four guards, in order of strength:

1. **The `style` op takes a token path from an enum of the project's own
   tokens.** "Green" can only resolve to the brand's semantic token. This
   mirrors gate 3 (tokens-only), which already governs generated components.
2. **Off-scale requires explicit intent.** "Exactly 37px" is allowed via
   `styleExact` and counted as off-scale; anything vaguer snaps to the space
   scale through the editor's existing `nearestSpaceStep`.
3. **Channels are restricted to what the node declares `editable`.** An
   archetype that never intended a node to be restyled still says so.
4. **Layout stays bounded** to size/position deltas (contract 6.1); the agent
   never emits anything implying reparenting.

The principle: **the agent chooses from the design system, not from open CSS** —
the same mechanism that keeps generated sections coherent, applied to edits.

## Validation

Performed in the editor, before anything is applied:

- the node exists in the manifest and its status is `active`
- the channel is present in that node's `editable` list
- a `style` token path resolves in `tokens.json`
- a `sectionOrder` list names every active section on the route
- the operation kind is known

Any failure rejects the whole batch.

## Failure handling

| Case | Behaviour |
|---|---|
| Ambiguous target | `clarify` returned; nothing applied; the user answers |
| Structural request | Cost confirmation, then the existing regen / add-section flow |
| One or more invalid operations | Nothing applied; plain-language rejection report |
| Haiku returns no valid operations | One retry on Sonnet 5 |
| Model or network failure | Surfaced; nothing applied |
| Empty `operations` and no `clarify` | Treated as "could not resolve"; reported, nothing applied |

## Testing

- **Python unit:** projection builder, prompt assembly, response parsing,
  escalation logic, structural detection.
- **TypeScript unit:** every validation rejection rule, and that a rejected
  batch applies nothing.
- **e2e (mock mode):** a deterministic operation source mirroring
  `WG_REGEN_MOCK`, driving the real editor UI — asserts overrides land, the
  summary lists them, and the whole prompt is a single undo entry.
- **Invariant suite:** one prompt-driven case, so agent-produced overrides pass
  through the same edit → export → pixel-diff proof as hand-made ones.
  Non-negotiable: this is the mechanism that keeps preview = handover.
- **Cost:** measured via `pricing.py`, not asserted from this document.

## Flagged for a human call

`docs/canvas-editor-prd-v1.md` describes editing as a canvas interaction and
does not describe a prompt surface. This design does not violate the contract —
it produces exactly the same override entries through the same channels — but
the PRD does not currently cover it. Per the standing rule this is **flagged,
not silently edited**: someone should decide whether the PRD gains a section for
prompt-driven editing before or after this ships.

A decisions.md row is owed when this is implemented, covering the agent's
placement and the operations-not-files boundary.
