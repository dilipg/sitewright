# M4 ID-Survival Stress Report

20 regeneration instructions (rewordings, structural changes, element removals, count changes, tone shifts)
against hero sections carrying overrides on 4 nodes each (build prompt 4.3).

| case | kind | base | passed | attempts | gate-7 retries | reattached | declared orphans | unexpected orphans | silent drops |
|---|---|---|---|---|---|---|---|---|---|
| c01 | reword | 01-ledgerly | PASS | 1 | 0 | 4/4 | — | — | — |
| c02 | reword | 02-bloomroot | PASS | 1 | 0 | 4/4 | — | — | — |
| c03 | tone | 03-forgefit | PASS | 1 | 0 | 4/4 | — | — | — |
| c04 | tone | 04-quietdesk | PASS | 1 | 0 | 4/4 | — | — | — |
| c05 | reword | 05-saffronlane | PASS | 1 | 0 | 4/4 | — | — | — |
| c06 | removal | 06-northstar | PASS | 1 | 0 | 3/3 | home.hero.eyebrow | — | — |
| c07 | removal | 07-driftless | PASS | 1 | 0 | 3/3 | home.hero.subheadline | — | — |
| c08 | removal | 08-pixelframe | PASS | 1 | 0 | 4/4 | — | — | — |
| c09 | count | 09-copperkettle | PASS | 1 | 0 | 4/4 | — | — | — |
| c10 | count | 10-vaultic | FAIL | 3 | 0 | 4/4 | — | — | — |
| c11 | structure | 01-ledgerly | PASS | 1 | 0 | 4/4 | — | — | — |
| c12 | structure | 02-bloomroot | PASS | 1 | 0 | 4/4 | — | — | — |
| c13 | structure | 03-forgefit | PASS | 1 | 0 | 4/4 | — | — | — |
| c14 | count | 04-quietdesk | PASS | 2 | 1 | 4/4 | — | — | — |
| c15 | removal | 05-saffronlane | PASS | 1 | 0 | 3/3 | home.hero.eyebrow | — | — |
| c16 | tone | 06-northstar | PASS | 1 | 0 | 4/4 | — | — | — |
| c17 | structure | 07-driftless | PASS | 1 | 0 | 4/4 | — | — | — |
| c18 | count | 08-pixelframe | PASS | 1 | 0 | 4/4 | — | — | — |
| c19 | structure | 09-copperkettle | PASS | 1 | 0 | 4/4 | — | — | — |
| c20 | removal | 10-vaultic | PASS | 1 | 0 | 2/2 | home.hero.eyebrow, home.hero.subheadline | — | — |

**Auto-reattach rate on conceptually-surviving elements: 71/71 = 100.0%** (bar: ≥ 90%)

**Silent drops: 0** (bar: zero) — every non-surviving override was declared and would appear in the orphan dialog

Gate-7 retries across the suite: 1. Failed cases: 1/20.
Unexpected orphans (survivor declared removed): 0. Missed expected orphans (instruction not fully applied): 0.

## Diagnosis of the two imperfect cases

- **c10 (FAIL, gate 4 × 3 attempts)** — not an ID-survival failure. The instruction ("add three customer
  names as social proof") led the model to do the contract-blessed thing: list items rendered in a `.map()`
  with data-derived `nodeId` expressions (contract 5.2), plus manifest proposals for each. Gate 4's static
  scan only sees *literal* id attributes, so the proposals looked unattached and every retry of the correct
  pattern kept failing. All four overrides were preserved throughout (4/4 reattached even in the failed
  state, manifest rolled back). **Action**: gate 4 needs template-literal/map awareness before M5's list
  archetypes (feature-grid, pricing-tiers) — logged in decisions.md as M5 pre-work.
- **c14 (PASS after 1 gate-7 retry)** — the model replaced two CTAs with one and spuriously declared the
  still-attached subheadline in orphanedOverrides. The strict false-orphan check (beyond the contract
  letter, added in 4.1) caught it and the retry self-corrected. Without that check the user would have been
  told a live edit was orphaned.

## Milestone 4 exit criteria

- ≥ 90% auto-reattach on conceptually-surviving elements: **met at 100%** (71/71, including a component
  rename + two-column restructure in c19)
- Zero silent drops: **met** (every non-surviving override declared; the conservation invariant
  overridden = reattached + declared + silent held in all 20 cases)
- Gate-7 retry rate: 1/20 cases (5%), self-corrected on the first retry

**The stop-the-line risk is retired: semantic node IDs survive regeneration.**
