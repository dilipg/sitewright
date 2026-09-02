# Prompt-driven editing — status and restart guide

**Written:** 2026-08-03. **Updated:** 2026-08-04 — merged, and the live gap closed.
**Branch:** `feat/prompt-driven-editing` — **merged to `main` as `8f17e4a`**, branch deleted.
**HEAD:** `42d0595`
**Tree:** clean. `npm run check` green: 170 compiler · 108 editor · 246 orchestrator · 13 + 99 e2e = **636 tests**.

## State in one line

The feature is **implemented, reviewed, and ready to merge**. Every review finding and every parked item is resolved. **Two** open decisions remain, and both belong to a human rather than to this work.

## What was built

Slice 1 of 5 from the design doc. A user types an instruction ("make the hero
headline shorter"); an agent resolves it into typed override operations; the
editor validates them against the manifest and applies them through its
existing store as **one undo entry**. Structural requests ("add a testimonials
section") are detected and deferred to the existing paid regen/add-section
flows behind a cost confirmation, rather than silently spending.

| Layer | Files |
|---|---|
| Agent input (pure) | `orchestrator/src/orchestrator/edit_context.py` |
| Agent | `orchestrator/src/orchestrator/edit_agent.py`, two new roles in `config.py` |
| Endpoint | `POST /__edit-prompt` in `compiler/src/regen-api.ts`; `edit-protocol.ts`, `edit-mock.ts` |
| Shared property list | `compiler/src/style-properties.json` + `.ts` — one source of truth for exporter, agent schema, editor validation |
| Validation / apply | `editor/src/lib/edit-ops.ts` |
| UI | `editor/src/components/EditPrompt.tsx`, wiring in `App.tsx` |

Invariants verified as holding: only the editor writes override files; the
`style` op takes a token path from an enum of the project's own tokens (a raw
hex is unrepresentable, not merely rejected); all-or-nothing per prompt; one
prompt = one undo entry; agent-authored overrides pass the invariant suite's
edit → export → build → pixel-diff proof.

## Commits (oldest first)

```
4b5c593 docs: pre-flight plan fixes before execution
ec37dd1 feat(edit): route projection and token vocabulary for the edit agent
3b19e07 feat(edit): edit agent with token-constrained schema and one escalation
23a3742 feat(edit): /__edit-prompt endpoint with a deterministic mock mode
c775771 feat(edit): validate and apply agent operations, all-or-nothing
bca5655 fix(edit): close review gaps in operation validation
c123d36 feat(edit): prompt box, one history entry per prompt
ad39888 fix(edit): guard Enter against double-submit, add compound-op coverage
f806047 test(edit): invariant coverage for agent-authored overrides; measured cost
82c361a fix(edit): keyword-utility conflict removal, and a legible invariant case
b8cf443 fix(edit): make the real agent path work — null-vs-undefined, shell-free spawn
1968761 fix(edit): reject invalid sectionOrder ids; mock mirrors the agent's null shape
239cfc8 docs: status and restart guide for prompt-driven editing
e50c94d fix(edit): the wire-contract type now admits null, as the agent actually sends
1f3ea7e docs: all parked items resolved; branch ready to merge
```

## NEXT STEP

**Nothing.** This slice is merged, green, and live-verified.

The SDD workspace `.superpowers/sdd/2026-08-03-prompt-driven-editing/` has been
deleted: it existed to hold the per-task ledger and the parked findings, all of
which are now resolved and recorded here and in `docs/decisions.md`. Git history
is the record.

## Resolved: the last deferred item

`compiler/src/edit-protocol.ts` — the file whose own header calls it "the wire
contract" — declared `clarify` and `structural` as optional-only, while the
Python agent emits explicit `null` for both. That was the exact falsehood behind
the Critical bug: an editor check of `!== undefined` matched `null`, took the
structural branch, and threw on every real prompt while the suite stayed green
against a mock that omitted the keys instead.

The runtime bug was already fixed; what remained was a type that would lead the
next reader straight back into it. Fixed in `42d0595`, and the stricter type
immediately earned itself by catching an unguarded `result.operations[0]!` in
`edit-mock.test.ts`.

## Two decisions that are not mine

1. **RESOLVED:** the PRD now has section 3.6, "Prompt-driven editing (P1)",
   describing only what was actually built and pointing at the design doc.
   It was flagged twice and then closed on the instruction to complete
   pending items. **Worth a human sanity-check of the wording** — it is spec
   text, and I authored it rather than transcribing a decision.
2. **Slices 2–5 are unstarted**: accounts, BYOK secrets, tenancy/isolation,
   web-triggered generation. Each needs its own spec → plan → implementation
   cycle. The agreed destination is a hosted multi-user app; this slice runs
   single-user and is a stateless `{route, instruction}` request, so it moves
   there without redesign.

## Honest gaps, recorded not buried

- **Cost, measured live and with the cache visible.** Three real calls:

  | call | input | output | cache write | cache read | cost |
  |---|---|---|---|---|---|
  | uncached | 3,361 | 89 | — | — | $0.003806 |
  | cache write | 429 | 92 | 4,752 | — | $0.006829 |
  | **cache read** | 426 | 79 | — | **4,752** | **$0.001296** |

  A cached edit costs **$0.0013**, essentially the design's ~$0.001 estimate.
  The first prompt of a session pays a one-off write premium; every one after
  is ~$0.0013. Against ~$0.13 for a regeneration that is ~100× cheaper, as the
  design argued. **Prompt caching is proven, not assumed.**
- **RESOLVED: the live end-to-end gap.** Two real prompts against a real
  generated project both resolved correctly on Haiku with no escalation,
  returning real node ids from that project's manifest and honouring the
  29-member `property` enum — the specific thing that had been untested.
- **`cost_for_run(run_id)` still cannot see edit-agent spend.** The agent
  writes the global `usage.jsonl`; that function reads the per-run log, so
  per-run cost reports understate spend once editing is used. Open, recorded
  in `decisions.md`, not fixed.

## Two bugs worth remembering

Both were found by the final whole-branch review, after all six per-task
reviews had passed. Neither was reachable by a per-task review.

1. **The feature did not work outside mock mode.** The agent nulls absent
   fields; the editor tested `!== undefined`; `null !== undefined` is true, so
   the structural branch always won and threw on every prompt. Invisible
   because the TypeScript mock *omits* those keys and every test ran in mock
   mode — exactly the mock-diverges-from-real trap the design doc warned
   about. Hence commit `0f74fcf`'s mock change.
2. **`runCli` spawned with `shell: true` and unescaped arguments.** A
   multi-word instruction arrived as separate argv entries, argparse exited 2,
   no result line. It was also a **shell-injection surface fed by free-form
   user text** — the pre-fix test run demonstrated it, writing a file into the
   repo root via redirection from the instruction string. Now shell-free via
   one shared `runProcess`. This helper is shared with `/__regen`,
   `/__regen-page` and `/__add-section`, all of which were equally broken for
   any multi-word instruction and are now repaired.

## A note on the plan itself

Six of the plan's code blocks needed correction downstream: two miscounted
test totals, a Python escape sequence that would not parse, a TypeScript type
error, a vacuous route test, and a single-op mock that made the key undo test
unable to fail. The plan's code was written without ever being executed. The
review loop absorbed all of it — which is the loop working, not the plan being
good. Verify code blocks compile before committing a plan next time.
