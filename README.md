# Sitewright

**An AI website generator whose output a developer would actually keep.**

Type a one-line brief. An agent pipeline generates a complete multi-page site as
typed React source. You edit it on an infinite canvas — text, style, layout,
visibility, section order — and regenerate individual sections without losing
your edits. Then you export a zip of handover-quality code that matches the
preview **pixel-for-pixel on every node you touched**.

You run the whole stack on your own machine with your own API key. There is no
shared server; nothing you type or generate leaves your computer except the model
calls themselves.

---

## Why this repo might be worth a look

**The hard part isn't generating a site.** It's generating one, letting a human
edit it, regenerating half of it, and *still* shipping code that matches what the
human saw. The product's one unforgivable failure is **preview ≠ handover** — and
every structural decision below exists to prevent it.

Three things you can read here that most generated-code projects don't publish:

- **A decision log with its retractions intact.** [`docs/decisions.md`](docs/decisions.md)
  is 392 dated rows and counting, append-only. A claim that turned out wrong is corrected
  *beside* the original, never rewritten — because a silently-edited record hides
  that a review caught something. Some retractions are more instructive than the
  original claim.
- **Measured reports, including the ones that missed.** [`docs/reports/`](docs/reports/)
  holds 8 write-ups with real numbers — a wall-clock target that failed 3 runs out
  of 3 and says so, a 60.0fps canvas measurement against a real generated site, a
  100%-auto-reattach ID-survival stress suite, live cost figures ($1.09 for a
  10-section generation).
- **A live list of what's still broken.** [`docs/pending.md`](docs/pending.md) —
  every open item with the reason it's open and the premise that sets its
  severity. Nothing is quietly dropped.

It is also a fairly large case study in agentic development: **301 commits over
six weeks, 223 of them co-authored by Claude Code, 2,492 tests.** See
[How it was built](#how-it-was-built).

---

## Architecture: the decisions, and why each one exists

The whole design is downstream of one invariant — *an edit made in the canvas must
survive both regeneration and export.*

| Decision | Why it had to be this way |
|---|---|
| **Node IDs are semantic and immutable** (`home.hero.cta-primary`, never `child-3`) | A positional ID is reassigned the moment a section regenerates, silently moving every override onto the wrong element. |
| **Edits live in an override layer**, never in generated source | An agent rewrites its own files freely. If edits lived there, every regeneration would destroy them. |
| **The exporter is deterministic** and compiles overrides into source | Preview and handover must be the *same* artifact produced two ways, not two renderers that agree by luck. |
| **An invariant suite** (edit → export → build → screenshot-diff) is a required check | Preview = handover is the core promise, so it's enforced mechanically rather than reviewed by eye. It covers a full edit-channel × archetype matrix. |
| **One writer per path** (`src/tokens/`, `src/shell/`, `src/pages/<route>/`, `overrides/`) | Write contention between parallel agents is *prevented by construction*, not resolved after the fact. |
| **`manifest.json` is only ever written by a deterministic service** | It's the ID registry. An LLM writing it freehand means IDs that drift, and IDs that drift mean lost edits. |
| **Seven validation gates** run after every agent and before every export, including the project's own `tsc --noEmit` | "Imports resolve; build passes" only ever did the first half — a section using an undeclared field passed every gate and then killed the run at export, after full spend. |
| **Every long operation is a server-side job**, polled by the browser | `succeeded` means *the request completed*, not that the work passed — a gate failure is a successful job with `passed: false`. A job left running across a restart becomes `interrupted`, never retried, because the server cannot know whether the child finished. |
| **BYOK, and the master key is deleted from `process.env` after boot** | The compiler's three spawn sites pass no `env`, so the key would otherwise be inherited into model-authored build config. |
| **The HTTP route table *is* the allowlist** | An unregistered path is unreachable, not merely unguarded. |
| **No HTTP route can create a user** — only the operator CLI can | Invite-only becomes a property of the code rather than a feature nobody implemented. |

Two more decisions that took a real incident to arrive at: the spend cap refuses
with **402, not 429** (every client library retries a 429, and retrying cannot
help until the window rolls), and page fan-out defaults to **serial** because two
workers 424 ms apart once raced the metadata store and shipped a component file
with no manifest entry — a site that looks finished in the canvas and can never
be exported.

---

## How it's structured

Four packages, one repo:

- **`orchestrator/`** (Python 3.12, uv) — the agent pipeline: intake, planner,
  design system, shell, and a page fan-out that generates each section from one of
  **27 archetype templates** plus a fallback.
- **`compiler/`** (TypeScript) — the deterministic spine: manifest service, token
  deriver, the seven validation gates, the exporter, the preview bridge.
- **`editor/`** (React + Vite) — the infinite canvas, the edit channels, persisted
  undo/redo, and the hosted-mode screens you log into.
- **`server/`** (Node, `node:sqlite`) — accounts, sessions, your encrypted API
  key, the spend cap, the job queue, and a per-project preview proxy. It is a
  *separate composition root*: the local CLI preview stays unauthenticated, and
  auth was added by composing a different root rather than by editing any handler.

Plus `fixtures/acme-landing`, a hand-written ground-truth project that serves as
the permanent test bed — stable while generated output varies.

`docs/` holds the binding specs, and they resolve top-down:
[the codegen contract](docs/codegen-contract-v1.md) **wins all conflicts**, then
[the pipeline spec](docs/agent-pipeline-spec-v1.md), then
[the editor PRD](docs/canvas-editor-prd-v1.md). `CLAUDE.md` is the orientation
document for anyone — human or agent — changing the code.

---

## How it was built

Written end to end by **Claude Code**, with the human acting as reviewer and
approver rather than author. What made that work at this size wasn't autonomy — it
was refusing to start from a prompt. Every feature went through the same loop,
using the [Superpowers](https://github.com/obra/superpowers) skill set:

```
brainstorming  →  design spec  →  writing-plans  →  implementation plan
   →  executing-plans / subagent-driven-development  →  test-driven-development
   →  requesting-code-review (whole-branch)  →  verification-before-completion
```

with `systematic-debugging` for anything that surprised us and `using-git-worktrees`
to keep parallel slices isolated. That produced **5 design specs**
([`docs/superpowers/specs/`](docs/superpowers/specs/)) and **12 implementation
plans** ([`docs/superpowers/plans/`](docs/superpowers/plans/)), each committed
before the code it described.

The receipts that the loop was doing real work, all countable from git:

| Evidence | Count |
|---|---|
| Commits / co-authored by Claude | 301 / 223 |
| `fix(` commits vs `feat(` commits | **90 vs 85** — it found more than it added |
| Commits citing a *perturbation* (breaking the implementation to prove a test catches it) | 29 |
| Commits citing a whole-branch review finding | 28 |
| Tests (compiler 298 · editor 437 · server 907 · pytest 714 · Playwright 13 + 123) | **2,492** |

**Where the human actually intervened:** approving each design spec and plan,
authorizing spend before live runs, and occasionally ruling on scope — one
milestone shipped with a wall-clock target missed 3 runs out of 3, reported
honestly rather than rounded up, on an explicit "don't remediate this now."

**What agentic work kept getting wrong**, which is the more useful half:

1. **The same defect shape, at ten separate layers** — an unvalidated string
   reaching a path, a URL, or a spawn argument. `..` normalized away by
   `path.join`; a rail whose regex `^[A-Za-z0-9._-]+$` matches `..` because `.`
   is in the character class; a project id where a single `encodeURIComponent`
   pass isn't enough. Each was found on its own. The *pattern* was only named
   after the fifth — and naming it is what found the rest.
2. **Verification plans are suspect too.** In one hardening round, four of the
   plan's own checks were wrong, and one would have filed a *working* feature as
   broken: it hashed `<route>/*.tsx`, which never matches, because section
   components live in `<route>/sections/`. It survived only because the claim got
   re-derived from three independent signals. The standing rule that came out of
   it — **when a check says a feature is broken, suspect the check first**, and
   prefer evidence the code under test does not write (money, file mtimes, billing
   rows) over its own logs.

---

## Quickstart

```bash
docker compose up          # server :4000, editor :5173 — then open http://localhost:5173/
```

One prerequisite has no default: **`WEBGEN_MASTER_KEY`** (32 random bytes, base64)
encrypts your stored API key. Nothing in this repo will generate it for you as a
convenience — a default there would make the stack boot beautifully every time and
make every previously-saved API key silently undecryptable.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Contributors run it from source instead, which is the only path that can run the
test suites (the image ships no browsers):

```bash
npm run check    # vitest ×3, pytest, and both Playwright suites — exactly what CI runs
```

**→ [`docs/runbook.md`](docs/runbook.md) is the full runbook**: both paths step by
step, what a first start looks like versus a hang, PowerShell equivalents,
troubleshooting, and what to expect before you press Generate — a generation
spends real money on your key and cannot be cancelled.

---

## Status and license

A hobby project, not a product — read [`docs/pending.md`](docs/pending.md) before
relying on anything. The deployment model it was designed and tested against is
**one local user, on their own machine, with their own key**; several open items
are deferred *because* of that premise, and the file says which ones and what
would un-defer them.

No license is granted yet.
