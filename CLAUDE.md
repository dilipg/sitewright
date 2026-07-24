# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product summary

An AI website-generator: a user types a one-line brief, an agent pipeline generates a complete multi-page marketing/storefront/SaaS site as typed React source, the user edits it on an infinite canvas (text, style, layout, visibility) and regenerates individual sections without losing edits, then exports a zip of developer-handover-quality code that matches the preview **pixel-for-pixel on every edited node**. The product's one unforgivable failure is preview ≠ handover; the entire architecture (stable node IDs, an override layer, a deterministic exporter) exists to prevent it.

## Current state

The repo is scaffolded (prompt P0 done): all packages exist with **placeholder tests only — no product logic yet**. The build order and exact per-step prompts live in [docs/build-prompts-v1.md](docs/build-prompts-v1.md); work through them in sequence (next: P2, then milestone 1). Do not invent structure; follow the docs.

## Documents and their authority

Read these before writing code. Conflicts resolve top-down:

1. **[docs/codegen-contract-v1.md](docs/codegen-contract-v1.md)** — the binding contract between every code-generating agent, the editor, the override layer, and the exporter. **This document wins ALL conflicts.** Where any other doc, or code, appears to contradict it, the contract is correct.
2. [docs/agent-pipeline-spec-v1.md](docs/agent-pipeline-spec-v1.md) — orchestration DAG, agent definitions, prompt templates, token budget, Kitaru integration. May not violate the contract.
3. [docs/canvas-editor-prd-v1.md](docs/canvas-editor-prd-v1.md) — the editing surface (canvas, bridge shim, edit channels, regen UX, export flow).
4. [docs/build-plan-v1.md](docs/build-plan-v1.md) — milestone execution order and what "done" means at each.
5. [docs/build-prompts-v1.md](docs/build-prompts-v1.md) — the step-by-step build playbook (one prompt per session).
6. [docs/decisions.md](docs/decisions.md) — decision log (created in prompt P2); append a row for any call the docs don't cover.

## Ownership map (hard rules — from contract section 2)

Write contention is prevented by construction, not resolved. Each path has exactly one writer:

- `src/tokens/` and `src/primitives/` — **only** the Design System Agent (`tokens.css` is *derived* from `tokens.json`, never hand-edited).
- `src/shell/` (incl. `routes.ts`, the ground-truth route table) — **only** the Shell Agent.
- `src/pages/<route-slug>/` — **only** that route's Page Agent; a page agent writes nowhere else and never imports from another page's directory.
- `overrides/<route-slug>.overrides.json` — **only** the editor. No agent ever writes overrides.
- `manifest.json` — append-and-update **only** through the deterministic manifest service (never freehand, never by an LLM directly).

Target package layout (per [docs/build-plan-v1.md](docs/build-plan-v1.md) section 0): `orchestrator/` (Python 3.12, uv, pytest — the agent pipeline), `editor/` (Vite + React + TS — the canvas), `compiler/` (TS library, vitest — manifest service, token deriver, validation gates, exporter, bridge-shim protocol; shared by editor and CLI), `prompts/` (versioned archetype templates), `fixtures/` (hand-written ground-truth project), `generated/` (gitignored output workspace).

## Build philosophy (from build-plan section 0 — these govern ordering)

1. **Walking skeleton first.** One route, one archetype, one edit channel, real export, wired end to end before any breadth. Every integration risk lives at the seams (agent → manifest → shim → override → exporter); the skeleton forces every seam to exist early.
2. **Risk before breadth.** Prove the three architecture-invalidating risks *inside* the skeleton: node-ID survival across regeneration, preview/export fidelity, and prompt-cache economics. Do not defer them to polish.
3. **Deterministic before generative.** Build and test every mechanical component (manifest service, gates, exporter, shim) against the hand-written fixture project *before* any LLM generates its input. Debugging generated code through untested infrastructure means two unknowns per bug.

The `fixtures/` project is the permanent test bed for `compiler/` and shim changes — it is stable while generated output varies. It never fully dies.

## Verify commands

One root command runs every package's test suite: **`npm run check`** (npm workspaces for `compiler/` and `editor/`, then `uv run --directory orchestrator pytest`). CI runs exactly this command. Per-package tools: `orchestrator/` → pytest (Python 3.12 via uv); `compiler/` and `editor/` → vitest; editor/shim end-to-end → Playwright (from milestone 2). The **invariant suite** (edit → export → build → screenshot-diff, [docs/canvas-editor-prd-v1.md](docs/canvas-editor-prd-v1.md) section 7.1) is a required CI check and the enforcement mechanism for preview = handover; it runs on every change to the shim, the exporter, or the primitive set.

Validation gates (contract section 8) run after every agent and before every export via `compiler/`'s `runGates` / the `gates <dir>` CLI. Export runs typecheck + gates + a production build and **fails loudly** — a failed export never ships silently degraded code.

## Standing rules

- **Never modify `docs/` to make code pass.** The docs are the spec. If the docs are wrong, ambiguous, or in conflict, stop and flag the problem to the human with a clear report — do not resolve it by editing a doc silently.
- Red tests never cross a commit boundary. Commit after each build-prompt step with its given message prefix.
- Generated output (`generated/`) is disposable; fixtures and tests are not. Fix a generation-quality problem in the template or the contract enforcement — **never hand-patch generated files.**
- Any decision the docs don't cover → one row in [docs/decisions.md](docs/decisions.md).
- Node IDs are semantic (`home.hero.cta-primary`), never positional (`child-3`), and immutable once registered — positional IDs break regeneration.
