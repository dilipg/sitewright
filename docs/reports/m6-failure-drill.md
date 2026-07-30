# Milestone 6.3 — failure-surface drill

Build prompt 6.3 asks for "one automated (or scripted-manual) test per row of
the section-8 failure table". Every row is covered by automated tests — no row
needed a scripted-manual procedure, so nothing here is a manual checklist.

This document is the row → test mapping. It exists because the coverage is
spread across three suites by necessity (a gate rejection is a compiler
concern, a placeholder rendering is an editor concern, a retry budget is an
orchestrator concern), so no single test file can show that the table is
fully handled.

Run everything with `npm run check`.

## The table (pipeline spec section 8)

### Row 1 — Thin brief → one clarifying round, then proceed with recorded assumptions

| Test | What it pins |
|---|---|
| `test_failure_surface.py::test_first_intake_round_may_ask_clarifying_questions` | the first intake call *may* ask |
| `test_failure_surface.py::test_the_second_intake_round_cannot_ask_again` | "one round" is structural, not advisory — the follow-up tool schema has no `clarifyingQuestions` field and requires `brief`, so a second round is unrepresentable |
| `test_failure_surface.py::test_the_brief_carries_recorded_assumptions_forward` | what intake guessed travels with the brief to every downstream agent |

This row had **no coverage before 6.3**.

### Row 2 — Planner picks bad structure → user approves plan before spend

| Test | What it pins |
|---|---|
| `test_plan.py::test_approval_gate` | generation refuses to start against an unapproved plan (`SystemExit`), and a missing plan directory stays allowed for canned-brief runs |
| `plan.spec.ts` (3 tests) | the approval screen lists routes/archetypes, section briefs are editable and persist to `siteplan.json`, and approving reveals the canvas |

### Row 3 — Gate failure → bounded retry with failure report injected

| Test | What it pins |
|---|---|
| `test_failure_surface.py::test_the_failure_report_is_injected_into_the_retry_prompt` | the report reaches the retry prompt; a clean first attempt is not polluted with an empty block |
| `test_failure_surface.py::test_the_retry_budget_is_bounded` | `MAX_ATTEMPTS == 3` (1 generation + 2 retries) — the bound is what makes a persistently-failing section terminate instead of looping on spend |
| `test_section_pipeline.py::test_user_prompt_with_failures_appends_the_report_block` | the report block's exact shape |

Observed live, end to end: the 6.1 storefront run's `cart.cart-drawer` used all
3 attempts against a real gate-5 failure and then produced a placeholder — see
the DAG report screenshot evidence in the section below.

### Row 4 — Section fails twice → placeholder + surfaced report; site continues

| Test | What it pins |
|---|---|
| `test_section_pipeline.py::test_assemble_page_index_source_handles_a_failed_section_placeholder` | the assembled page imports and renders the placeholder |
| `test_failure_surface.py::test_a_failed_section_becomes_a_placeholder_and_its_siblings_still_render` | the *siblings survive* — the page still assembles around the hole |
| `test_failure_surface.py::test_a_page_of_only_failures_still_produces_a_valid_module` | the degenerate all-sections-failed page is still a compilable module, imported once |
| `failure-surface.spec.ts` (4 tests) | **preview rendering**: the placeholder is visibly rendered with its "see the run log" pointer, the sibling section stays fully selectable, the placeholder carries no node id (so the editor offers no edits for it), and other routes are unaffected |

The **preview rendering half had no coverage before 6.3**. The fixture's
`about` route now carries a `FailedSectionPlaceholder` as permanent test-bed
coverage of this shape — it is deliberate, not a defect (see that page's own
comment). All 6 gates pass with it present, which also proves the placeholder
is gate-legal: it claims no node id, and its user-visible string lives in
`src/lib/`, outside gate 5's section-JSX scope.

### Row 5 — Worker crash → resume from section checkpoint

| Test | What it pins |
|---|---|
| `test_failure_surface.py::test_a_crashed_page_worker_is_recorded_and_its_siblings_still_finish` | a nonzero exit is recorded with its stderr (diagnosable, resumable), the other routes still complete, and the run does **not** pass just because the gates did |
| `test_failure_surface.py::test_fanout_fails_when_gates_fail_even_though_every_worker_exited_clean` | the converse: clean exit codes are not evidence the project is sound; the project-level gate 6 check can still reject |
| `test_failure_surface.py::test_the_fanout_write_log_and_ownership_files_are_cleaned_up` | the gates-CLI scratch files never leak into an export |

`fanout.py` had **no tests at all before 6.3**. The page-worker subprocesses
and the gates CLI are faked, so what these exercise is the crash-isolation
control flow rather than model behavior.

### Row 6 — Manifest conflict → manifest service rejects; treated as gate failure

| Test | What it pins |
|---|---|
| `manifest.test.ts` (10 `rejects…` tests) | positional ids, <2-segment ids, non-slug segments, already-registered ids, duplicates within a batch, out-of-boundary files, unknown owners, channel values outside the closed set, resurrection with a different file/component, proposals outside the section prefix |
| `test_failure_surface.py::test_a_rejected_plan_produces_a_report_shaped_for_prompt_injection` | "treated as a gate failure" means the rejection comes back as report **lines a retry prompt can carry**, not as an exception |
| `manifest-lock.test.ts` | the cross-process file lock that prevents concurrent fan-out writers from interleaving manifest writes |

### Row 7 — Regen removes overridden element → orphanedOverrides surfaced

| Test | What it pins |
|---|---|
| `gates.test.ts` "runGates: gate 7 (regen ID survival)" | a previously-overridden id must be attached *or* declared orphaned — and a declared orphan that is still attached is equally a failure (a false orphan would make the user discard a live edit) |
| `regen.spec.ts::orphaned override dialog: lists exactly the lost edit, discard clears it` | the dialog surfaces exactly the lost edit and discard clears it |
| `regen.spec.ts` (2 more) | the full round-trip with a surviving override re-applied + revert, and a failed regen surfacing its report with a try-again affordance |

### Row 8 — Export build failure → export aborts loudly

| Test | What it pins |
|---|---|
| `exporter.test.ts::fails loudly on token-shaped refs that resolve to no token` | the export throws **and removes its output directory** — no partial export (contract 7.4) |
| `exporter.test.ts::refuses a zip target inside the export directory` | same abort-and-clean-up behavior on a bad target |
| `export.spec.ts::a failing export is loud: the panel names the cause and offers a retry` | the editor renders the specific offending value, a retry affordance, and **no download link** alongside a failure |

The export panel also renders the failing gate's own per-failure report and the
build log (`ExportPanel.tsx`), driven by the structured body `export-api.ts`
returns rather than a flattened string.

## DAG run report (pipeline section 7)

`uv run python -m orchestrator.run_report <run-id> [-o out.html]` reconstructs
the pipeline DAG from the flat JSONL event stream and writes a self-contained
HTML report: per-node status, cost and token counts with rollups, a timeline
bar per node, and drill-down to the exact rendered system prompt, user prompt
and raw output for every attempt.

VERIFY — rendered against two real full runs:

| Run | Result |
|---|---|
| `acceptance-1785393866-035be240` (6.1's passing storefront) | 5 stages, 18 nodes, 4 routes, 13 sections, 316.7s, $1.1278 / 153,313 tokens, status **passed** |
| `acceptance-1785391917-f9e8d5bf` (a genuinely failed run) | 16 nodes, status **failed**, all 7 failed sections identified, `cart.cart-drawer` showing its 3 exhausted attempts and the exact gate-5 messages |

Both totals were cross-checked against `pricing.py`'s independent
`cost_for_run` aggregation and agree to 6 decimal places (a synthetic version
of that check is pinned by
`test_run_report.py::test_the_dag_total_agrees_with_run_cost_on_the_same_events`).

Driven in a real browser (Chromium via Playwright): 18 timeline bars render,
drill-down opens and its system/user-prompt/raw-output tabs all switch
correctly, the failed run shows its red rollups, and there are **zero JS
errors**.

### Known limitation, and what 6.3 did about it

Run-log timestamps are written when a call *completes*, so before 6.3 a node's
timeline bar could only mark where it finished — the width was the gap between
a section's generation and validation events, which understates the work.

6.3 added `duration_s` to every model call (measured once at
`call_model_structured_impl`'s dispatch, so it covers both providers) and
threads it into the run log. The report now derives a node's true start from
`completion − duration` and shows measured model time per node, per route, per
stage and per run. Runs logged *before* 6.3 still render: measured latency is
omitted rather than shown as `0s`, and the bar falls back to the event span
(`test_a_run_logged_before_durations_existed_still_renders`).

This also closes an observability gap milestone 5.5 hit directly: fan-out
missed its wall-clock target and there was no per-call latency data to explain
where the time went ([m5-acceptance.md](m5-acceptance.md)).
