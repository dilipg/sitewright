# M3 Walking-Skeleton Soak Report

10 generation runs with distinct briefs (build prompt 3.4). Section budget: 25,000 tokens; ceiling 2x.

| run | gates | attempts | invariant | uncached in | cache read | cache write | out | total tokens |
|---|---|---|---|---|---|---|---|---|
| soak-01-ledgerly | PASS | 1 | PASS | 1,967 | 0 | 2,434 | 1,729 | 6,130 |
| soak-02-bloomroot | PASS | 1 | PASS | 1,964 | 2,434 | 0 | 1,749 | 6,147 |
| soak-03-forgefit | PASS | 1 | PASS | 1,961 | 2,434 | 0 | 1,710 | 6,105 |
| soak-04-quietdesk | PASS | 1 | PASS | 1,951 | 2,434 | 0 | 1,720 | 6,105 |
| soak-05-saffronlane | PASS | 1 | PASS | 1,959 | 2,434 | 0 | 1,707 | 6,100 |
| soak-06-northstar | PASS | 1 | PASS | 1,960 | 2,434 | 0 | 1,719 | 6,113 |
| soak-07-driftless | PASS | 1 | PASS | 1,966 | 2,434 | 0 | 1,708 | 6,108 |
| soak-08-pixelframe | PASS | 1 | PASS | 1,954 | 2,434 | 0 | 1,707 | 6,095 |
| soak-09-copperkettle | PASS | 1 | PASS | 1,954 | 2,434 | 0 | 1,722 | 6,110 |
| soak-10-vaultic | PASS | 1 | PASS | 1,946 | 2,434 | 0 | 1,702 | 6,082 |

**Fully green: 10/10** (exit bar: >= 9/10)

**Mean section cost: 6,110 tokens** = 0.24x budget (bar: <= 2x)

## Worst three outputs

All ten passed mechanically; ranking is qualitative (copy review of every hero).

1. **soak-07-driftless** — fabricated a plausible real-domain external URL (`https://vimeo.com/driftlesskayaks/shop-tour`); every other run honestly used `.example` placeholders. **Template fix**: instruct that external URLs must use placeholder domains unless the brief supplies real ones. (Applied: hero.md 1.0.1.)
2. **soak-09-copperkettle** — internal copy contradiction: headline promises "one cup a week", subheadline says "mails … each month". **Sampling**, mitigated by a template quality-bar line requiring internally consistent facts. (Applied: hero.md 1.0.1.)
3. **soak-05-saffronlane** — secondary CTA labeled "See this week's menu" links to `/` (the page itself). **Context fix**: the M3 single-route stub gives CTAs no internal targets; resolves itself in M5 when the Site Planner produces real route tables. No template change.

Recurring pattern, not counted as a defect: primary CTAs link to `/` in all runs — same single-route context limitation.

## Milestone 3 exit criteria

- 10 consecutive runs with distinct briefs pass all gates within the retry budget: **met** (10/10, all on attempt 1)
- Editor edit → export → invariant pixel-diff per run: **met** (full 4-case invariant suite per run, 10/10)
- Rendered prompt, output, cost, checkpoint tree visible in run log: **met** (`orchestrator/runlog/soak-*.jsonl`, viewer, `kitaru executions list`)
- Token cost per section within 2× of the 25k budget: **met at 0.24×** — prompt caching held across all runs (the 2,434-token prefix cache-wrote once in run 1, cache-read in runs 2–10)

**The walking skeleton is complete: brief → generated hero → canvas edit → export, end to end.**
