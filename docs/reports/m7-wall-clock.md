# Milestone 7.3 — wall-clock diagnosis

Milestone 5.5 measured wall clock as the pipeline's failing metric: 0/3
acceptance runs inside the 5-minute target, 2/3 inside the 10-minute ceiling,
attributed at the time to per-section generation latency running "~1.6–2.4×
the docs' own ~55s/section assumption" ([m5-acceptance.md](m5-acceptance.md)).

6.3 added `duration_s` to every model call specifically so that claim could be
checked. Nobody had looked at the data. This is that look.

## Headline: the diagnosis was wrong, and the metric now passes

| | 5.5 (3 routes) | 7.3 (4 routes, 8 sections) |
|---|---|---|
| Wall clock | 547–650s | **286s** |
| 5-minute target | 0/3 | **inside** |
| Assumed per-section latency | ~55s (docs), 88–132s (inferred) | — |
| **Measured** per-section latency | not measurable | **27.1s median, 26.6s mean** |

Per-section model latency is roughly **half** what the docs assumed and a
third of what 5.5 inferred. The inference was reasonable at the time — with
only completion timestamps, per-section time is indistinguishable from
per-section *overhead* — but it was wrong, and it pointed optimization effort
at the model when the model was never the problem.

## Where the time actually goes

Measured on `acceptance-1785415481-52ca587e` (4 routes, 8 sections, 286s wall,
312s of summed model time — summed exceeds wall because fan-out is parallel).

**Roughly half the run is the sequential prelude.** The first section-generating
model call starts ~149s in. Everything before it — intake (4.8s), plan (6.5s),
design (70.3s), shell (17.1s) — is strictly sequential and cannot be
parallelised by fan-out. Design alone is a quarter of the total run.

**Fan-out is not model-bound.** The four workers finished within *0.6 seconds
of each other* despite carrying very different loads:

| Worker | Sections | Model time | Wall |
|---|---|---|---|
| cart | 1 | 33.1s | 163.2s |
| product | 1 | 28.7s | 163.2s |
| shop | 2 | 67.5s | 163.1s |
| home | 4 | 83.6s | 162.6s |

A worker with 1 section and 33s of model time took the same wall clock as one
with 4 sections and 84s. If model latency dominated, `home` would have taken
~2.5× `cart`. It did not, and all four converging on 163s is the signature of a
shared, saturated resource rather than of independent work.

**The per-section gap is ~15s, and it is contention, not work.** Consecutive
sections on the `home` worker are separated by a consistent gap:

```
home.hero              model 12.9s
  gap 16.2s
home.featured-candles  model 31.9s
  gap 14.3s
home.social-proof      model 25.5s
  gap 15.5s
home.cta-band          model 13.4s
```

That gap covers `write_section_only` + `commit_section_manifest` +
`run_gates_step` + the next prompt render. Measured **in isolation** during a
single-section regeneration, those same checkpoints cost:

```
write_section_only       0.137s
commit_section_manifest  0.250s
run_gates_step           1.605s
```

≈2s. Under 4-way fan-out the same work takes ~15s — a **~7× inflation** from
running four page workers on one machine, each spawning `node` for the gates
CLI (ts-morph parse + `tsc`), and each contending for the manifest's
cross-process lock. Fixed per-worker startup is not the culprit either:
`uv run python -c "import orchestrator.page_worker"` is 3.6s, paid once.

## What this means for optimisation

The levers are now ordered by evidence rather than assumption:

1. **The sequential prelude (~149s, over half the run).** Design is 70s of it.
   Nothing in fan-out can help; this is where a real reduction would come from.
2. **Local CPU contention during fan-out (~13s per section of pure
   inflation).** Fan-out spawns one worker per route regardless of how many
   cores the machine has. Bounding concurrency to available cores, or making
   gate runs cheaper, attacks this directly.
3. **Model latency — the thing 5.5 blamed — is the smallest lever.** 27s per
   section, already running in parallel.

Deliberately **not** optimised here. The metric currently passes (286s against
a 300s target), so spending the change budget on a passing metric would be
premature — and one of the two candidate optimisations has a real cost worth
weighing first: the gate-1 typecheck added in 6.4 is whole-program (~1.4s CPU
per section attempt, multiplied by concurrent workers). Moving it to once per
route would cut contention but would also delay type errors past the section's
own retry budget, losing the self-correction that made it worth adding. That
trade deserves its own decision, not a drive-by.

## A reporting bug this exposed

Reading the second run's report showed a wall clock of **44 hours**. The run
log is append-only and keyed by `run_id`, so the section regenerations run
during 7.1 appended to the same log a day later, and the report's
first-event-to-last-event span swallowed the gap.

Fixed: events are grouped into sessions split on gaps longer than 15 minutes,
`duration_s` describes the first session (the original generation), and the
report header notes `+N later session(s)` when a log contains more. Sessions
are computed from raw event timestamps rather than node aggregates — a section
regenerated later merges into the *same* DAG node, so node-level start/end
times hide the gap entirely.

Both real runs now report sanely: 286s (0 later sessions) and 512s (1 later
session, the 7.1 regen work).
