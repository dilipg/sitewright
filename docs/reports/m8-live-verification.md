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

---

## V2 — add-section against a live model

7.6 (add-a-section) had **never run against a live model** — only unit tests and
mock-mode e2e. It is a **first generation, not a replay**: the section never
existed, so there is no recorded Kitaru execution to fork, which is precisely
what mock mode cannot exercise. This run is the first time
`orchestrator/src/orchestrator/add_section.py` has been executed against a real
API over the hosted HTTP path.

### Identifiers, verbatim

| | |
|---|---|
| Endpoint | `POST /__add-section?project=ba169e65-f173-4cff-9619-2909ef3fe8be` |
| Body | `{"route":"home","archetype":"faq-accordion","instruction":"Answer common questions about shipping, subscriptions, and bean freshness."}` |
| HTTP response | **202** `{"jobId":"ca23a7fc-48c7-4e26-bc29-83e685299085"}` |
| jobId | `ca23a7fc-48c7-4e26-bc29-83e685299085` |
| kind | `add-section` |
| project directory | `generated/web-2578801a-9d5a-4461-90eb-4a771fde5648` |
| enqueued / started / finished | 1786345993761 / 1786345993855 / 1786346046448 |
| wall clock | **52.6 s** (job start to finish) |
| terminal result | `{"passed":true,"sectionId":"home.faq-accordion","archetype":"faq-accordion","failureReport":"","canRevert":true}` |

### Archetype choice, and why

The live catalog (`GET /__archetypes`) returned **27** archetypes — not the 20
`CLAUDE.md` describes, because the form-builder set (`app-shell`,
`element-palette`, `builder-canvas`, `properties-inspector`, `form-renderer`,
`data-toolbar`, `data-grid`, `detail-drawer`) was added after that text was
written. Not a defect; noted because the doc is stale.

`home` already used **hero, feature-spotlight, product-card-grid, social-proof,
cta-band** (confirmed against both `plan/siteplan.json` and the manifest's five
section-root ids, not assumed from Task 2's journal). `faq-accordion` appears on
`pricing` only (`pricing.pricing-faq`), never on `home`, so it was
**unambiguously new to the target route** — which is what the Step 4 assertions
require — and is the natural choice for a coffee-roaster home page. Used as
written in the brief, instruction unchanged.

### Assertions

**1. `status === "succeeded"` and `result.passed !== false` — PASS.**

Both checked explicitly, and this is the first task in the round where THE TRAP
is *not* vacuous: `/__add-section` is a proxied kind, so a gate failure would
have arrived as a `succeeded` job with `passed: false`. It did not.
`result.passed` is `true` — the stronger condition, not merely `!== false`.

**2. A new `.tsx` under `src/pages/home/` — PASS.**

Per-file MD5s taken before and after. Exactly three files differ, and no
existing section's source changed:

```
> FaqAccordion.tsx          (new)
> FaqAccordion.data.ts      (new)
  index.tsx  b3cfa47d... -> 76ee604922be8a9c9d70cb38b1ae7aab   (changed)
```

`index.tsx` gained two imports and one render line, appended — never
re-assembled, which is what stops a page's `FailedSectionPlaceholder` being
silently dropped (`add_section.py` docstring, point 2).

**3. Registered in `manifest.json` with semantic node ids — PASS.**

184 to **205** nodes: **21 added, 0 removed, 0 modified**. Every added id is
semantic; none is positional:

```
home.faq-accordion                                    (section, editable: style/layout/visibility)
home.faq-accordion.heading                            (Heading)
home.faq-accordion.description                        (Text)
home.faq-accordion.faq-shipping-time{,.question,.answer}
home.faq-accordion.faq-freshness{,.question,.answer}
home.faq-accordion.faq-subscription-flexibility{,.question,.answer}
home.faq-accordion.faq-subscription-savings{,.question,.answer}
home.faq-accordion.faq-grind-options{,.question,.answer}
home.faq-accordion.faq-satisfaction-guarantee{,.question,.answer}
```

The six list-item slugs are drawn from the *meaning* of each question
(`faq-shipping-time`, `faq-freshness`, ...), not from its index. The source
builds them as the contract-5.2 template form `${nodeId}.faq-${faq.key}` — the
shape 7.1 had to fix for 19 of 20 archetypes — present and correct here, so this
section is regenerable. The list-item data shape carries the four exporter-only
override slots (`className`, `childClassNames`, `hidden`, `childHidden`)
required by contract 5.5.

**4. A `sectionOrder` override naming every section on the route — FAIL, by
design. See F9.**

`overrides/home.overrides.json` is **byte-identical before and after**:

```json
{ "version": 1, "route": "/", "overrides": [] }
```

No `sectionOrder` override was written, because `add_section.py` deliberately
never writes one — "Position is not this module's business" (its docstring,
point 3). Positioning is the **editor's** job (`App.tsx:1025-1040`, calling
`placeSectionAfter`). Over the pure HTTP path the brief prescribes, that code
never runs. Detail and consequences in **F9**; the *substance* of the assertion
(that an order, once written, must name every section) was verified separately
and **holds** — see **F10**.

**5. The site plan reflects the new section — PASS.**

`plan/siteplan.json`'s `home` route gained a sixth entry, appended:

```json
{ "slug": "faq-accordion", "archetype": "faq-accordion",
  "brief": "Answer common questions about shipping, subscriptions, and bean freshness." }
```

The instruction is recorded verbatim as the section's brief, so a later re-plan
or regeneration sees it.

### Step 5 — export, all seven gates

`POST /__export` returned 202 `{"jobId":"d10c48fa-953f-45b3-9ec4-fe0153922507"}`,
terminal **`succeeded`** in **3.0 s** with `ok: true`, 71 files,
`zipBytes: 67667`, `appliedOverrides: 0`, `tombstoned: []`,
`integrationCount: 0`, `offScaleCount: 0`.

The production build genuinely ran — `...-export/dist/assets/` holds a
494,668-byte JS bundle and a 55,182-byte CSS bundle, and `WG_EXPORT_SKIP_BUILD`
is set nowhere outside `editor/playwright.config.ts`, so gate 1's `tsc --noEmit`
and `npm run build` both executed against live-generated code. The exported
`src/pages/home/sections/FaqAccordion.tsx` and its mock data are present, and
the FAQ copy is in the built bundle.

**The brief's stated check for this step is unsatisfiable — see F11.**
`/__export` returns `ok`, never `passed`, so `result.passed === true` is false
for every export that has ever succeeded.

### Live preview

Driven in a real browser (Edge via `chromium.launch({ channel: "msedge" })`;
curl cannot see this, per V1's F2). `GET /preview/<projectId>/` returned 200 with
**111** `[data-node-id]` nodes on `home`, up from 90 — exactly the 21 added. All
21 FAQ nodes are individually addressable, and the accordion renders real
content:

```
"How fast will my coffee arrive?" | "How fresh is the coffee, really?" |
"Can I pause or change my subscription anytime?" | "Do I save money with a subscription?" |
"Can I choose whole bean or a specific grind?" | "What if I don't like a bag I ordered?"
```

DOM section order: `home.hero -> home.story -> home.beans -> home.trust ->
home.cta -> home.faq-accordion`. **The FAQ renders after the closing
call-to-action band** — the visible consequence of F9. The only console errors
are V1's F7 (unresolvable invented image hostnames); no new page errors.

### Cost

Read from `usage_event`, never estimated.

| | |
|---|---|
| Rows attributed to this run | **1** (`role: page`, `claude-sonnet-5`) |
| Tokens | 3,227 in / 4,282 out / 4,252 cache-creation / **0 cache-read** |
| **Cost** | **$0.089856** |
| Unpriced (`cost_usd IS NULL`) rows | **0** — the figure is exact, not a floor |
| Estimate in the brief | ~$0.12 |
| Cumulative round spend | $1.739645 to **$1.829501** |

Under estimate, and the round is at $1.83 of ~$6 authorised. One model call for
one section, which is the whole shape of the operation.

Worth noting: **`cache_read_input_tokens` is 0**. This run got no prompt-cache
benefit from V1's generation an hour earlier — expected, since the cache TTL is
far shorter, but it means an add-section always pays full price for its design
context.

---

### F9 — `/__add-section` writes no `sectionOrder` override, and the API cannot position a section at all

**Assertion 4 fails as literally stated, and it fails by design.**
`add_section.py` appends the new section to the end of the page's source and
explicitly declines to place it:

> **Position is not this module's business.** Node ids are semantic and never
> positional (contract 5.2), so a new section appends to the source and the
> EDITOR places it with a `sectionOrder` override (PRD 3.3, milestone 7.5).

That is coherent, and the editor does hold up its end (`App.tsx:1025-1040` ->
`placeSectionAfter`). But two things follow that are worth stating plainly:

1. **The HTTP API has no position parameter.** `POST /__add-section` accepts
   `{route, archetype, instruction}` and nothing else. The editor's own
   `AddSectionState` carries `afterSection`, but it is *purely client-side* — it
   is never sent. So any consumer of the hosted API other than this one editor
   can only ever append. Slice 5 made the job model the product surface; this
   capability did not follow it there.
2. **The observable result on this run is a bad page.** The FAQ renders *after*
   the closing CTA band, confirmed in the browser. Nothing is broken, but the
   default placement for an appended section is the one position a closing band
   makes wrong.

Not filed as a code defect, because the docstring and the editor agree and no
contract is violated. Filed because the brief asserted the override would exist,
and over the prescribed path it does not — and because the gap between "the
editor can position a section" and "the API can" is invisible until someone
drives the API directly, which is what this round did.

### F10 — a pre-existing reorder plus an add-section leaves an un-exportable project

This is the risk F9 creates, and it is **reachable in production**. Proven
empirically rather than reasoned about: a copy of the live project was made in
the session scratchpad (outside the repo — the project itself was never
hand-patched) and exported twice through `compiler/scripts/export.ts`.

**Probe B — the stale order.** A user reorders `home` (5 sections, override
written), then adds a section. The override now names 5 of 6:

```
$ node compiler/scripts/export.ts <probe> <out>
sectionOrder for route "home" omits "home.faq-accordion"; a reorder must list
every section on the route, or the omitted ones would vanish from the export.
(exit 1)
```

**Probe A — the healed order.** The full 6, FAQ moved before the CTA:

```
Exported with 1 override(s) -> .../out-A
71 file(s) packaged; 0 integration TODO(s), 0 off-scale override(s)
(exit 0)
```

and the exported `index.tsx` renders `Hero -> Story -> Beans -> Trust ->
FaqAccordion -> Cta`.

**The design works exactly as documented.** `validateSectionOrder`
(`exporter.ts:373`) is strict on purpose, and it names the omitted section rather
than dropping it — the substance of the brief's assertion 4 holds, even though
the assertion itself does not. Preview = handover is not at risk.

The exposure is narrower than it first looks: the editor rebuilds a *full* order
after every add (`placeSectionAfter` starts from `sectionOrderOf`, which returns
every rendered section), so the ordinary in-editor flow self-heals. It fails only
when that client-side write does not land — an API-driven add, a session that
401s between the job and the override write, or a closed tab. The job has already
`succeeded` server-side by then, so the project is left un-exportable until
someone reorders again. **Loud, recoverable, and not silent content loss** —
which is the property the design was built for — but a server-side operation
leaving a project in a state only the client can repair is worth recording.

### F11 — `/__export`'s result has no `passed` field, so the plan's stated check is unsatisfiable

The plan and this task's brief both say the export step expects "`succeeded` with
`result.passed === true`". `/__export` has never returned a `passed` field.
`export-api.ts:55-65` returns `{ ok, files, handover, integrationCount,
offScaleCount, appliedOverrides, tombstoned, zipName, zipBytes }`, and a failure
returns **HTTP 200** with `{ ok: false, message, gateReport?, buildLog? }` —
deliberately, so the editor can render the gate report field by field instead of
receiving a 500-with-a-string.

Because `job-worker.ts:1123-1124` maps *any* 2xx to `succeeded` with the body
verbatim, **a gate-failing export arrives as a `succeeded` job with `ok: false`.**
So THE TRAP is real for `/__export` too — but under a different field name than
the one the plan tells a verifier to check. Checking `result.passed !== false` on
an export is vacuously true and would pass a gate failure straight through.

**The code is correct**: `App.tsx:1214-1217`'s THE TRAP comment reads `ok`, not
`passed`. This is a defect in the plan and brief, and a second instance of V1's
F1 (`result.passed` does not exist on a `generate` job either). Stated precisely,
for the two remaining tasks: THE TRAP's `passed` field is real for `/__regen`,
`/__regen-page`, `/__add-section` and `/__edit-prompt`; `/__export` uses `ok`;
`generate` has neither.

### F12 — cosmetic: a reordered `index.tsx` ships mis-indented

Surfaced by probe A, and pre-existing 7.5 behaviour rather than anything
add-section introduced. `applySectionOrder` rewrites the fragment's children
through ts-morph and does not re-indent, so a reordered page's exported
`index.tsx` is:

```tsx
    <>
            <Hero nodeId="home.hero" {...heroData} />
            ...
          </>
```

against the 6-space, correctly-closed original. It compiles, the build passes,
and no pixel is affected — but "developer-handover-quality code" is the product's
stated bar, and this is the one file a developer reads first to understand the
page. Not fixed: out of this task's scope, and the exporter is load-bearing for
the two runs still to come in this round.

### F13 — the regen snapshot is ONE global slot, not one per route (code reading, not empirically proven)

Noticed while confirming what state V2 hands to V3, because `/__add-section`
takes a route-wide snapshot exactly as a regen does (`regen-api.ts:171`).
`.regen-backup/` is a **single directory for the whole project**, and
`snapshotRoute` clears it before every write (`regen-api.ts:245-250`):

```ts
function snapshotRoute(root: string, routeSlug: string): void {
  const backup = snapshotDir(root);
  rmSync(backup, { recursive: true, force: true });
  cpSync(join(root, "src", "pages", routeSlug), join(backup, "page"), { recursive: true });
  cpSync(join(root, "manifest.json"), join(backup, "manifest.json"));
}
```

Nothing in the snapshot records **which route it came from**, and
`restoreSnapshot` (`regen-api.ts:254-262`) copies `backup/page` into
`src/pages/<whatever route the caller named>` after deleting that directory.
So a caller that regenerates `about` and then reverts `home` would have
`home`'s page directory **replaced by `about`'s sections**, plus `about`'s
manifest — cross-route corruption, not a no-op.

**Severity is bounded by who can call it, and the editor cannot.** `App.tsx`
keeps a single `revertSection` that every regen overwrites and every revert
clears (`App.tsx:1124-1136`), so the editor's own `revertSection` always
matches the snapshot that exists. The hazard lives on the **HTTP surface**:
`/__regen-revert` accepts any `{route}` or `{section}` the caller sends, and
slice 5 made that surface the product. Two lesser consequences of the same
single-slot design are reachable from the editor: only the most recent
regenerated route is ever revertable (a second route's regen silently discards
the first's undo), and a second revert throws `no regeneration to revert`
because `restoreSnapshot` deletes the backup on the way out.

**Not empirically proven** — no revert was issued in this task, and proving it
would mean deliberately corrupting the live project V3 and V4 still need. Filed
from code reading, with the exact line references, so V3 (which does drive
`/__regen-revert` over HTTP) can confirm or refute it cheaply. Recorded here
rather than fixed: it is a design question about snapshot scoping, not a
contained bug, and the round's rules send those back to the human.

One directly operational consequence for V3, already verified on disk:
`.regen-backup/` currently holds `home`'s **pre-add-section** state (its
`manifest.json` is 54,103 bytes — the 184-node one — against the live 205-node
manifest). A revert issued *before* V3's own `/__regen-page` would therefore
delete the section V2 just added.

---

## V2 verdict

**Verified, with findings.** Add-a-section works against a live model on its
first-ever real run. The single most valuable thing this proves is that the path
mock mode structurally cannot reach — a *first generation* of a section that
never existed, `generate_section_flow` with `reuse_workspace=True` — runs
correctly end to end: 21 new semantically-named nodes, zero existing ids
disturbed, the page's `index.tsx` appended rather than re-assembled, the site
plan updated, all seven gates plus a real `tsc --noEmit` and production build
passing afterwards, and the section rendering live and individually addressable
in the preview. 52.6 s and $0.0899, both inside expectations.

**Assertion 4 is the one that did not hold**, and the reason is a design boundary
rather than a bug: positioning lives in the editor, so the HTTP API appends and
cannot place. The consequence on this run is visible — the FAQ sits after the
closing CTA band — and the associated risk (F10) is real but loud and
recoverable, not silent. The exporter's strictness, which is what assertion 4 was
really testing, was confirmed empirically in both directions.

The project is released to V3 with **6 sections on `home`, 205 nodes, and an
empty `home.overrides.json`.**
