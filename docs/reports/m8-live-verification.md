# Live verification round 1 — measurement report

Round 1 of the post-slice-5 live-verification plan
([docs/superpowers/plans/2026-08-10-live-verification.md](../superpowers/plans/2026-08-10-live-verification.md)).
Four runs against a real Anthropic API over the real hosted HTTP path, each
reporting spend read from `usage_event` rather than estimated.

Harness: one `server/scripts/serve.ts` on port 4000, one operator-created user
(`verify-round1@local.test`, cap $20/24h, BYOK key fingerprint `aQAA`), every
verification driven as an authenticated `curl` request exactly as a browser
would.

---

## V1 — control generation

The baseline: a clean, web-triggered generation with no fault injection. Tasks
V2–V4 run against its output, so V1 passing is a precondition for the rest of
the round.

### Identifiers, verbatim

| | |
|---|---|
| Brief | `A three-page marketing site for a small-batch coffee roaster: home, about, and pricing.` |
| jobId | `ed1b5088-eebf-44c9-967c-294ddc3f9705` |
| projectId | `ba169e65-f173-4cff-9619-2909ef3fe8be` |
| runId | `web-2578801a-9d5a-4461-90eb-4a771fde5648` |
| project directory | `generated/web-2578801a-9d5a-4461-90eb-4a771fde5648` |
| export directory | `generated/web-2578801a-9d5a-4461-90eb-4a771fde5648-export` |
| job `code_version` | `05d53603e7ba1bcfb0f862f9ef058717e43082e9` (the server's boot HEAD) |
| enqueued | `2026-08-10T06:41:22Z` (epoch 1786344082) |
| finished | epoch 1786344759444 |

**`projectId` and `runId` are different UUIDs, and this is by design.**
`POST /api/generate` returns `project.id` (a `randomUUID`); the run directory
is `project.directory`, an independently generated `web-<uuid>`
(`job-routes.ts:116`), and the job's `run_id` equals that *directory*, not the
project id. `user-cli list-projects` prints the **directory**
(`user-cli.ts:133`), so its output never matches the id the HTTP API just
handed back. See "Findings" — the plan's own commands assume they are the same
string.

### Result

| Metric | Value |
|---|---|
| Terminal status | **`succeeded`** |
| `result.passed` | **absent** (a `generate` result is `{ stdout }` only — see Findings) |
| `error` | absent |
| Routes | 3 (`home`, `about`, `pricing`) |
| Sections | 11 (home 5, about 3, pricing 3) |
| `.tsx` under `src/pages` | 14 (11 sections + 3 page `index.tsx`) |
| Manifest nodes | 184 (home 90, about 47, pricing 47) |
| `degraded_sections` | `[]` — no `FailedSectionPlaceholder`, no retry exhaustion |
| Wall clock | **676.8 s** (11 m 17 s) |
| Cost | **$1.7396** |

### Every assertion, with its result

| # | Assertion | Result | Evidence |
|---|---|---|---|
| 1 | `POST /api/generate` returns **202** with `{ jobId, projectId }` | **PASS** | `HTTP_STATUS=202`, both fields present |
| 2 | The project row exists before the job has run | **PASS** | `project` row `created_at=1786344082661`, identical to the job's `created_at`; the row is written before the job is queued |
| 3 | The project directory exists before the job has run | **PASS (command in the brief is wrong)** | `generated/web-2578801a-…` created `06:41:22Z`, the same second as the enqueue. `ls generated/$PROJECT_ID` fails, because the directory is named after `project.directory`, not `project.id` |
| 4 | Terminal `status === "succeeded"` | **PASS** | `"status": "succeeded"`, `error` absent |
| 5 | `result.passed !== false` | **PASS, vacuously** | `result.passed` is `undefined`; a `generate` result has exactly one key, `stdout`. The trap's second half is structurally inapplicable to this job kind — see Findings F1 |
| 5b | Gates/typecheck/build actually passed (the check assertion 5 was meant to make) | **PASS** | `acceptance.py:170` raises `StageError` on a non-zero exporter exit, and `export.ts` runs typecheck + all 7 gates + a production build. The job exited 0 and the export contains a populated `dist/`, so all three passed |
| 6 | Spend read from `usage_event`, not estimated | **PASS** | `$1.74 spent of $20.00`; 18 rows summing to `$1.73964475` |
| 7 | No `unpriced events` note (the figure is a total, not a floor) | **PASS** | 0 rows with `cost_usd IS NULL`; orchestrator reported `"unpriced_models": []` |
| 8 | Ingested cost equals the orchestrator's own total | **PASS** | `1.73964475` on both sides, bit-for-bit |
| 9 | Every `usage_event` attributed to the right user and project | **PASS** | all 18 rows carry `user_id=b7ddb7e3-…` and `project_id=ba169e65-…` |
| 10 | 3 route directories under `src/pages` | **PASS** | `about`, `home`, `pricing` |
| 11 | Site plan matches what was generated | **PASS** | `siteplan.json` declares home 5 / about 3 / pricing 3; 11 section files exist, one per planned section |
| 12 | Preview renders with node ids present | **PASS in a browser; the brief's `curl` check cannot measure it** | Edge via Playwright: **90 / 47 / 47** `[data-node-id]` on `/`, `/about`, `/pricing`. `curl \| grep -c data-node-id` returns **0** — structurally, for any CSR SPA — see Findings F2 |
| 13 | The 4c-1 `basename` regression has not recurred | **PASS** | all three routes render real content under the `/preview/<id>/` prefix; `main.tsx` carries `basename={import.meta.env.BASE_URL}` |
| 14 | Node ids are semantic, never positional | **PASS** | `home.hero.cta-primary`, `pricing.pricing-tiers`, …; 0 of 184 ids match `\.\d+$` or `child-\d+` |
| 15 | Rendered node count matches the manifest | **PASS** | browser 90+47+47 = 184; manifest 184; `HANDOVER.md` independently states "184 addressable nodes" |
| 16 | The export is a real handover package | **PASS** | `HANDOVER.md`, `manifest.json`, `src/`, `package.json`, `tsconfig.json`, and a populated `dist/` |
| 17 | Wall clock inside the m7 model's prediction | **FAIL** | predicted 349 s, actual 676.8 s, **+327.8 s (+94 %)** — see below |
| 18 | Wall clock inside the product ceiling (10 min, m5 performance table) | **FAIL** | 676.8 s = 11 m 17 s, **over the 600 s ceiling** |
| 19 | Cost inside the product target (< $10) | **PASS** | $1.74, 83 % under |
| 20 | Cost inside this task's own ~$1.10 estimate | **FAIL** | $1.74, **58 % over** — see Findings F4 |

### Wall clock: prediction vs actual

Per the plan, this is compared against `m7-wall-clock.md`'s **model**, not
against its 286 s headline — that number was measured on a different shape
(4 routes / 8 sections).

**The model:** a ~149 s sequential prelude, then per section on the
critical-path worker ~27 s of model latency plus ~13 s of contention = 40 s.
Wall clock is bounded by the worker with the most sections, since fan-out is
truly parallel.

**This run's shape:** 3 routes, 11 sections, critical path = `home` with 5.

```
predicted = 149 + 5 x (27 + 13)
          = 149 + 200
          = 349 s
```

*(Sanity check of the model against its own source run: 4 routes / 8 sections,
critical path `home` with 4 → 149 + 4x40 = 309 s against a measured 286 s. The
model over-predicts by 8 % there, so it is not biased low.)*

**Actual: 676.8 s. Gap: +327.8 s (+94 %).**

Decomposed against this run's own measurements:

| Term | Modelled | Actual | Delta | Share of gap |
|---|---|---|---|---|
| Sequential prelude | 149 s | **381.2 s** | **+232.2 s** | **71 %** |
| Fan-out (5-section critical path) | 200 s | 279.9 s | +79.9 s | 24 % |
| Export | not modelled | 7.9 s | +7.9 s | 2 % |

**The per-section term held; the prelude term did not.** Measured per-section
model latency was **29.2 s median / 28.4 s mean** across 12 calls — within 8 %
of m7's 27.1 s / 26.6 s. Contention should have been *lower* here than in m7
(3 concurrent workers rather than 4), so the 13 s/section allowance was
generous. Section generation is not where the time went.

The prelude is, and one stage dominates it:

| Stage | m7 | V1 | Delta |
|---|---|---|---|
| plan (incl. intake) | 11.3 s | 32.2 s | +20.9 s |
| **design** | **70.3 s** | **328.9 s** | **+258.6 s** |
| shell | 17.1 s | 20.4 s | +3.3 s |

Inside design, from the Kitaru checkpoint log:

```
generate_tokens          11.97 s
write_tokens              0.21 s
generate_primitives      138.04 s   <- attempt 1
write_primitives          14.63 s   <- attempt 1 FAILED validation
generate_primitives_2    142.70 s   <- attempt 2 (same checkpoint, retried)
write_primitives_2         2.19 s   <- attempt 2 passed
```

**The failed first attempt cost ~152.7 s and $0.36** — 23 % of the run's wall
clock and 21 % of its cost, spent producing primitives that were thrown away.
`design_pipeline.py:535` is a bounded retry loop; attempt 1 produced files that
passed `validate_primitive_output` but then failed `write_primitives`' own
`tsc --noEmit` + gates check, so all 16 primitives were regenerated.

But the retry is not the whole story. **Even excluding it, design would have
been ~176 s — still 2.5x m7's 70.3 s.** Each primitives call emitted
22,167 and 23,179 output tokens; ~45 k output tokens for the primitive set is
the underlying cost, and it is paid whether or not a retry happens.

Fan-out's own +79.9 s is largely one section retry (`generate_section#a2`,
43.8 s of model time plus a second gates pass) landing on the critical-path
worker. 12 `section.generated` events for 11 sections; exactly one retry.

**Read plainly:** the m7 model remains a good description of fan-out and a poor
description of the prelude. The prelude was 2.6x what it predicts, and the
Design System Agent is 88 % of that excess.

### Cost

$1.7396 total, 209,278 tokens, 18 model calls.

| Role | Calls | Cost |
|---|---|---|
| intake + planner (haiku) | 2 | $0.0084 |
| design-system (sonnet) | 3 | $0.7441 |
| shell (haiku) | 1 | $0.0102 |
| page sections (sonnet) | 12 | $0.9769 |

**Design is 43 % of the bill for 0 of the site's content** — $0.744, of which
$0.361 was the discarded first primitives attempt.

---

## Findings

### F1 — `result.passed` does not exist on a `generate` job, so the documented trap check is inapplicable

`CLAUDE.md` and the plan both state the rule: "succeeded" means
`status === "succeeded"` **and** `result.passed !== false`. For a `generate`
job the second half can never fire. `job-routes.ts` wraps the orchestrator's
output as `{ stdout }` and nothing else; there is no `passed` key to be
`false`. `result.passed !== false` is therefore satisfied by a job that failed
every gate, purely because `undefined !== false`.

It happens to be safe here, but for a different reason than the rule states:
`acceptance.py:170` raises on a non-zero exporter exit, so gate failure lands
the job in `failed`, not in `succeeded` with a falsy payload. The trap is real
for the five proxied job kinds and vacuous for `generate` — and the difference
is invisible at the call site.

Recorded, not fixed: this is a documentation/shape observation, and the task's
constraint was to change no production code.

### F2 — the `curl | grep -c data-node-id` preview check is structurally always 0

The plan's Step 5 treats a zero count with HTTP 200 as the 4c-1 failure
signature. It cannot be: the preview is a **Vite dev server serving a
client-rendered SPA**. The served HTML is 814 bytes and its body is exactly

```html
<div id="root"></div>
<script type="module" src="/preview/<id>/src/main.tsx"></script>
```

No `data-node-id` can appear in it whether routing works or not. 4c-1's own
"0 nodes against 77 at base `/`" was measured **in a browser**, and only a
browser can reproduce it.

Re-run in real Edge via Playwright, all three routes render: **90 / 47 / 47**
node ids, totalling exactly the manifest's 184. The `basename` fix is present
in `main.tsx` and working. **The regression has not recurred** — but the plan's
check would have reported "finding" on a perfectly healthy preview, and would
equally report "finding" on a genuinely broken one. It has no discriminating
power in either direction.

*(Playwright's own browsers are not installed in this checkout;
`channel: "msedge"` against the system Edge works and needs no download.)*

### F3 — every generated site ships a browser tab reading `<UNKNOWN>`, and it survives into the handover

The brief names no company, so the intake agent honestly emitted a sentinel and
recorded the gap:

```json
"brand": { "name": "<UNKNOWN>", "tone": "artisanal, passionate", ... },
"assumptions": [ "The roaster has not specified a brand name; we will need this before design work begins.", ... ]
```

Nothing downstream recognises the sentinel. `shell_pipeline.py`'s
`brand_scaffold` stamps `brand.name` verbatim:

- `index.html` → `<title>&lt;UNKNOWN&gt;</title>` — confirmed as the literal
  browser tab text `<UNKNOWN>` in Edge, on all three routes
- `package.json` → `"name": "unknown"` (via `brand_slug`)
- both are **byte-identical in `…-export/`**, the developer handover

Meanwhile the Shell Agent, handed `BRAND: <UNKNOWN>` in its system prompt,
ignored it and invented one: the rendered nav reads **"Artisan Roasters"**. So
the shipped site says *Artisan Roasters* in the header and `<UNKNOWN>` in the
tab, with a package named `unknown`.

`shell_pipeline.py:140`'s guard is `.get("brand", {}).get("name", "the brand")`
— a default that fires only when the key is *absent*, never when it is present
and holds the sentinel.

This is the 6.4 handover finding recurring in a new form. 6.4 fixed "every
generated site ships the FIXTURE's identity"; the fix replaced a wrong name
with a placeholder that leaks. A developer opening the handover still sees the
wrong name before they see anything else — the exact sentence
`brand_scaffold`'s own docstring uses to justify its existence.

### F4 — V1 cost 58 % more than the plan's estimate, and the round's total estimate is now unreachable

Estimated ~$1.10; actual **$1.74**. The round's overall estimate is $2.72
against a ~$6 authorisation. V1 alone consumed 64 % of the estimate. If V2–V4
land on their own estimates, the round finishes near **$3.4–4.0** — inside the
$6 authorisation, well outside the $2.72 estimate.

Two contributors are visible in this run's own data: the discarded primitives
attempt ($0.36) and the one section retry (~$0.11). A retry-free run would have
cost ~$1.27 — still above $1.10.

### F5 — the run log labels a retried checkpoint in a way that reads as two distinct steps

Kitaru's own stdout names the second attempt `generate_primitives_2` /
`write_primitives_2`, as though they were separate pipeline stages. They are
not: `design_pipeline.py:535` is a `for attempt in range(...)` loop calling the
same checkpoint. The run log's `checkpoint_ref` gets this right
(`generate_primitives#a1` / `#a2`), but the two disagree in appearance, and the
stdout spelling is what a human reads first. It cost real time here to
establish which one was true.

### F6 — the exact validation failure that triggered the design retry is not recoverable

`write_primitives` returns `{"ok": False, "issues": [...]}` and those issues are
fed into the next attempt's prompt, but nothing persists them. The run log
records model calls only — no checkpoint inputs, no failure reports — and
Kitaru's store is hosted, not local. So "the design agent burned $0.36 and 153 s
on a retry" is observable, while "because of *what*" is not. For a stage that
is now 43 % of the bill, that is a real observability gap.

### F7 — 10 broken images on the home page, from two different invented hostnames

Every `<img>` on `/` points at a reserved `.example` domain that can never
resolve:

```
https://images.roastworks.example/story/{bagging-line,roast-curve,farm-visit,cupping-table}.jpg
https://images.yourbrand.example/beans/{yirgacheffe-konga,finca-la-esperanza,kirinyaga-peaberry,san-fermin-honey,sumatra-mandheling,midnight-blend}.jpg
```

All 10 fail `net::ERR_NAME_NOT_RESOLVED` in a real browser, so the canvas the
user edits on shows broken images, and the handover ships them.

Note the **two different hostnames**: `Story.tsx` and `Beans.tsx` were
generated by separate model calls, and nothing gives them a shared asset
convention, so each invented its own. Image replacement is a supported edit
channel (7.7, TEXT with key `src`), so a placeholder is expected — but a
never-resolvable one, spelled differently per section, is a poor default rather
than a neutral one.

### F8 — minor: `GET /api/jobs/:id` does not expose `run_id`

`publicJobView` (`job-routes.ts:137`) returns an explicit field list that omits
`run_id`. V4's Step 1 says "note the `runId` from the job row"; over HTTP there
is no way to. It is recoverable only from the database, or from the identity
`run_id === project.directory`. Flagged so V4 does not lose time to it.

---

## V1 verdict

**Verified, with findings.** The happy path works end to end over the hosted
HTTP path: 3 routes, 11 sections, 184 semantically-identified nodes, zero
degraded sections, a preview that genuinely renders under the proxy prefix, a
clean export with a real production build, and spend correctly metered and
attributed to the right user down to the last significant digit.

Two measured misses, both reported rather than rounded: **wall clock breached
the 10-minute product ceiling (676.8 s)**, and **cost ran 58 % over this task's
estimate**. Both trace mostly to one stage — the Design System Agent, which
took 328.9 s and $0.74 to produce none of the site's content, and threw away a
$0.36 attempt on the way.

`$PROJECT_ID` and `$RUN_ID` are released to V2–V4 as recorded above.
