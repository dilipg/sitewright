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

---

## V3 — page regeneration and revert against a live model

7.9 had **never run against a live model**. Two claims were at stake: that the
sequential loop regenerates **each** section rather than rewriting one file N
times, and that **one revert restores the whole page** from a single route-wide
snapshot. Both hold. Getting there required correcting two errors in the
verification instructions themselves, and the *evidence* for the first claim is
not the evidence the brief predicted.

### Identifiers, verbatim

| What | Value |
|---|---|
| jobId | `81ed8d3e-b8d8-4a58-bf78-36e8bf1ab2b5`, kind `regen-page` |
| projectId (HTTP) | `ba169e65-f173-4cff-9619-2909ef3fe8be` |
| run directory (filesystem) | `generated/web-2578801a-9d5a-4461-90eb-4a771fde5648` |
| instruction | `Warmer, more personal tone throughout; keep all facts and structure.` |
| HTTP | `POST /__regen-page?project=…` -> **202** `{ jobId }` |
| terminal status | `succeeded` **and** `result.passed === true` |
| wall clock | **316 s** polled; **305.9 s** server-side (`finishedAt - startedAt`) |
| cost | **$0.562575**, 6 `usage_event` rows, 0 unpriced |

`attempts: 6`, `gate7Retries: 0`, `orphanedOverrides: []`, `tombstoned: []`,
`failureReport: ""`, `overriddenIds: []`, `canRevert: true`.

### Result

```
sections:   ["home.hero","home.story","home.beans","home.trust","home.cta","home.faq-accordion"]
perSection: { home.hero: true, home.story: true, home.beans: true,
              home.trust: true, home.cta: true, home.faq-accordion: true }
```

### Every assertion, with its result

| # | Assertion | Result |
|---|---|---|
| 1 | Every section regenerated — not one file N times | **PASS**, but *not* via the signal the brief named (F16) |
| 2 | `perSection` has one entry per section, count matches file count | **PASS** — 6 entries, 6 section roots, 6 section files |
| 3 | Node ids survived; compare against `manifest.json` | **PASS** — 111/111 active `home` ids, 0 missing, 0 added, 0 tombstoned, 205 total unchanged |
| 4 | No orphaned overrides reported | **PASS** — `orphanedOverrides: []` (and `home.overrides.json` was empty going in) |
| 5 | One revert restores the page byte-identically | **PASS** — empty diff across all 15 tracked files including `manifest.json` |

### Assertion 1 — what actually proves it

The brief said to hash `src/pages/home/*.tsx` and assert every section file's
hash changed. Followed literally that check is **doubly wrong**, and both halves
matter (F14, F16):

- the glob matches exactly **one** file, `index.tsx` — section components live
  in `home/sections/`;
- and **no `sections/*.tsx` file changed at all**, on a run where every section
  genuinely regenerated.

A worker following the brief verbatim would have seen one unchanged hash and
reported a total failure of 7.9. The truth is the opposite. Three independent
signals, each sufficient on its own, show six distinct section regenerations:

**1. Six distinct data files, each with distinct new content.** All six
`mock/*.data.ts` changed; all six `sections/*.tsx` are byte-identical. That is
the architecture behaving correctly, not a miss: the instruction was tone-only
and *copy lives in the data file* while the component holds structure. Each
rewrite is section-appropriate — hero copy in `Hero.data.ts`, CTA copy in
`Cta.data.ts` — which is precisely what "one file rewritten six times" could not
produce:

```diff
-  eyebrow: "Small-Batch Roastery",
+  eyebrow: "From Our Family to Your Kitchen Table",
-    "We source rare micro-lots from single farms and roast each batch by hand, so every bag you brew tastes like the harvest that made it."
+    "We fall in love with a handful of rare micro-lots each season, roast every batch by hand with our own two hands, and get it to your door while the harvest is still singing in the cup."
```

```diff
-  heading: "Get this week's roast before it's gone",
+  heading: "Let us send your first bag of this week's roast",
```

Facts preserved (12-pound batches, 48 hours), structure preserved, tone warmer.
The instruction was honoured.

**2. Six distinct write timestamps, in section order.** Each section's `.tsx`
*and* its `.data.ts` share one mtime, and the six pairs are 30–90 s apart in
exactly the manifest's section-root order. The components *were* rewritten —
mtime moved — and simply came out byte-identical:

```
13:02:16  Hero.tsx + Hero.data.ts
13:03:48  Story.tsx + Story.data.ts
13:04:48  Beans.tsx + Beans.data.ts
13:05:26  Trust.tsx + Trust.data.ts
13:05:58  Cta.tsx + Cta.data.ts
13:06:47  FaqAccordion.tsx + FaqAccordion.data.ts
```

**3. Six billing events.** Six `usage_event` rows, one per section, at
07:32:14–07:36:45 UTC — the same six instants as the file writes (+05:30). One
file rewritten six times could not bill six differently-sized model calls.

### Assertion 5 — one revert, whole page

After correcting the request field (F15), `POST /__regen-revert` returned
`{"ok":true}` (HTTP 200), and the diff against the Step 1 hashes was **empty** —
all 15 tracked files byte-identical, including `manifest.json` and
`overrides/home.overrides.json`. The single route-wide snapshot taken before the
first section restored all six sections in one step, exactly as 7.9 claims.

Confirmed afterwards: 205 nodes, 111 `home` nodes, all six section roots in
order, other routes untouched, hero copy back to `"Small-Batch Roastery"`, and
`.regen-backup/` **deleted** (one revert only, as F13 predicted). Live preview
re-checked in a real browser: HTTP 200, **111 `[data-node-id]` nodes**, section
roots in DOM order `home.hero -> home.story -> home.beans -> home.trust ->
home.cta -> home.faq-accordion`. The only console errors are V1's pre-existing
broken `.example` image hosts (F7).

**F13's hazard was navigated, not triggered.** The snapshot slot held `home`'s
*pre-add-section* state when V3 began; issuing a revert first would have deleted
V2's FAQ. Running `/__regen-page` first overwrote the slot with the correct
6-section pre-regen state, and the revert then restored exactly that.

### Cost

| Section call | in | out | cache-create | cache-read | $ |
|---|---|---|---|---|---|
| 1 | 3 805 | 1 769 | 4 268 | **0** | 0.053955 |
| 2 | 8 530 | 4 928 | 4 200 | **0** | 0.115260 |
| 3 | 10 630 | 6 812 | 4 255 | **0** | 0.150026 |
| 4 | 7 000 | 3 114 | 4 254 | **0** | 0.083663 |
| 5 | 4 408 | 1 644 | 4 239 | **0** | 0.053780 |
| 6 | 7 722 | 4 452 | 4 252 | **0** | 0.105891 |
| **total** | | | | | **0.562575** |

All `claude-sonnet-5`, role `page`, 0 unpriced. **$0.5626 against the brief's
~$0.40 estimate — 41 % over** (F4's pattern again). Cumulative round spend
**$2.39207575**, well inside the $3.50 stop threshold and the ~$6 authorisation.

## Findings

### F14 — the brief's md5 glob matches one file, and it is not a section

`md5sum generated/$RUN_DIR/src/pages/home/*.tsx` returns exactly one line,
`index.tsx`. Section components are in `src/pages/home/sections/`. The check
designed to catch "one file rewritten six times" would itself have inspected one
file — and that file legitimately does not change on a regen, since `index.tsx`
is the page assembly, not section content.

This is a defect in the **verification instructions**, not in the product. It is
recorded because its failure mode is maximally misleading: it reports a false
*negative* on the exact claim the task exists to prove, and a worker who trusted
it would have filed 7.9 as broken.

### F15 — `/__regen-revert` takes `{ section }`, not `{ route }`

The plan's reference table and the brief's Step 4 both send `{"route":"home"}`.
The handler reads `body.section` (`compiler/src/regen-api.ts:216`) and answers
**400 `{"error":"invalid route slug"}`** — because the missing field yields an
empty slug, and the guard fails closed.

The code's own header comment, `POST /__regen-revert { section | route } -> { ok }`,
is what the plan appears to have been read from; it describes the accepted
**value** (`restoreSnapshot` explicitly takes "a section id or a bare route
slug"), not the field **name**. The editor sends `{ section: revertSection }`
(`editor/src/App.tsx:1129`), which is the real contract. `{"section":"home"}`
succeeded.

Two things worth noting. The 400 was a **clean fail-closed rejection that
changed nothing on disk** — the snapshot survived intact and the correct call
then worked, so the wrong field cost nothing but a round trip. And this is a
*documentation* defect: no production code was changed to complete the
verification. The header comment is ambiguous enough to have caused it and is
worth rewording to `{ section }  // a section id or a bare route slug`.

### F16 — a tone-only page regen changes no component file, and the brief asserts it must

Every `sections/*.tsx` on `home` is byte-identical across a regen in which all
six sections genuinely ran. This is **correct behaviour**: copy lives in
`mock/*.data.ts`, structure lives in the component, and the instruction asked
only for tone. The components were rewritten (mtimes moved) and reproduced
identically.

The finding is that the brief's assertion 1 — "**Every** section file's hash
changed" — is false as stated, and would be false for any content-only
instruction. The durable check for "each section regenerated" is the set of
**data** files plus per-section mtimes plus per-section billing rows, not the
component hashes. Anyone re-running this verification should assert on those.

### F17 — `manifest.json` key order is not stable across a page regen

Before and after the regen, `manifest.json` had the **same 205 keys, the same
2 458 lines, the same 60 497 bytes, and zero structurally-changed node records**
— but a different md5, because the key **order** changed: `home.hero` moved from
index 0 to index 94. The route's nodes are evidently removed and re-appended, so
the whole `home` block relocates behind `about` and `pricing`. Section-root
order *within* `home` is preserved.

Semantically harmless — it is a map keyed by node id, and every consumer looks
nodes up by key. Recorded because it means `manifest.json` is **not byte-stable
across a semantically-null regeneration**, which makes manifest diffs noisy and
would defeat any future check that hashes the manifest to detect real change.
Worth confirming it does not perturb 6.2's byte-identical export zip.

### F18 — the sequential page loop gets zero prompt-cache reuse

Every one of the six section calls paid ~4 250 cache-**creation** tokens and read
**0** cache tokens. Six sequential regenerations on one route, moments apart,
sharing the same contract and archetype preamble, and not one of them hit a warm
cache. V2's single add-section showed the same `cache_read 0`.

The consequence is that page-regen cost scales strictly linearly in sections
with no amortisation — a 10-section page would pay the full preamble ten times.
This is a cost-efficiency observation rather than a correctness defect, and it is
the most likely single lever on the 41 % cost overrun. Whether the cache TTL,
the cache breakpoints, or the per-section subprocess boundary is responsible was
not investigated here.

## V3 verdict

**Verified.** Page regeneration works against a live model on its first-ever real
run, and both claims 7.9 makes are true. The sequential loop regenerated **each**
of the six sections — proven three ways over, by content, by timing, and by
billing — with `perSection` reporting all six `true`, **100 % node-id survival
(111/111)**, zero orphans and zero tombstones. **One revert restored the entire
page byte-identically**, manifest included, from the single route-wide snapshot
taken before the first section, and then deleted the snapshot.

The two errors were in the verification instructions, not the product (F14, F15),
and one of them (F14) would have inverted the result. The three genuine product
observations — component files legitimately unchanged by a content-only regen
(F16), unstable manifest key order (F17), and zero cache reuse across the loop
(F18) — are none of them correctness failures, and F18 is the one with real
money attached.

Wall clock 305.9 s server-side for six sections (~51 s/section, consistent with
V2's 52.6 s single add) and $0.5626, 41 % over the brief's estimate.

The project is released to V4 in its **pre-V3 state**: 6 sections on `home`, 205
nodes, empty `home.overrides.json`, no `.regen-backup/` slot.

---

## V4 — Fan-out-subprocess resume, live

**VERIFIED.** The feature works. The blocking scenario the brief named — Kitaru
caching the *failure* so a resume replays it forever, making the feature inert —
**did not occur.**

Run id `web-32ceed17-d145-44ea-8a63-0ddedbd99761` · project `073d0747` ·
Kitaru **0.21.0** (pinned exactly in `orchestrator/uv.lock`; `pyproject.toml`
declares only `>=0.21.0`, and nothing in CI re-verifies this behaviour against a
future upgrade).

### The fault

`POST /api/generate`, then the orchestrator process **tree** killed mid-fan-out
(`taskkill /T`, required — page workers are subprocesses and killing only the
parent leaves them running).

| | Job | Status | Duration |
|---|---|---|---|
| Attempt 1 | `eb3cc481` | **failed** | 474.4s |
| Resume | `4aafd6ff` | **succeeded** | 210.9s |

**Step 4's decision point passed:** the killed job landed `failed`, not
`interrupted` and not stuck `running`. Had it landed otherwise, a real
orchestrator crash in production would not be resumable either — the brief
called for stopping and reporting, and that was not needed.

### Assertions

1. **Same `run_id`** — PASS. Both job rows carry
   `web-32ceed17-d145-44ea-8a63-0ddedbd99761`, and `resumed_from_job_id` links
   the resume to `eb3cc481`. Reusing the run id *is* the mechanism; no new
   Kitaru API was needed.
2. **Completed checkpoints replayed, not re-executed** — PASS, two independent ways.
   Splitting the append-only run log at the kill (07:59:14.205Z) and resume start
   (08:00:02.411Z):
   - attempt 1: 6 `section.generated` events / **6 distinct checkpoints**
   - resume: 6 events / **3 distinct checkpoints**
   - **overlap: 0.** No checkpoint that completed in attempt 1 was regenerated.
   - **prelude events in the resume window: 0** — intake, plan, tokens, both
     primitives steps and shell emitted nothing.
   Kitaru says so itself in the resume's own stdout: `Checkpoint intake_step
   cached.` / `Checkpoint planner_step cached.`
3. **Only incomplete work ran again** — PASS. 3 further section checkpoints, 8
   sections on disk at the end.
4. **The resume's cost is far below the first attempt's** — PASS, and this is the
   assertion a log line cannot fake.

| | Cost |
|---|---|
| Attempt 1 | $1.1842 |
| **Resume** | **$0.3621** |
| V4 total | $1.5463 |

**31% of the first attempt.** The prelude — which V1 measured at ~$0.74, over
40% of a full generation — cost **$0.00** on the resume. Assertions 2 and 4
agree; had they disagreed, the standing instruction was to trust the cost.

5. **Code-version guard** — PASS. Restarted with
   `WEBGEN_CODE_VERSION=deliberately-different-for-step-7`; resuming
   `eb3cc481` returned **409**: *"the server code has changed since this job ran;
   it cannot be resumed — start a fresh job instead."*

### F19 — the mechanism is NOT fully attributed, and this is the honest limit

The brief asked which of two independent mechanisms carries the replay. **It
cannot be answered from this run**, and saying so is worth more than guessing:

- The **prelude** replay is Kitaru's checkpoint cache, proven — but those
  checkpoints run in the **parent** process (`acceptance.py`), which was never
  the thing in doubt. Single-process Kitaru caching was already verified.
- The **section-level** skip is what the subprocess question is about, and the
  evidence establishes only the *outcome* (0 overlap, 31% cost), not the cause.
  **No `progress.json` exists anywhere in the finished project**, so
  `page_worker.py`'s file-based skip cannot be confirmed to have run — and it
  cannot be ruled out either, since the file may have existed mid-run and been
  cleaned up.

What is proven: **fan-out-subprocess resume works end to end, across a real
multi-process crash, at 31% of the original cost.** What remains open: whether
Kitaru's cache or the `progress.json` skip is load-bearing. Instrumenting that
needs a run that inspects the filesystem *during* fan-out, not after.

### F20 — nine section checkpoints produced eight sections

6 distinct in attempt 1 plus 3 in the resume is 9, against 8 sections on disk.
One section's attempt-1 work therefore did not survive into the final site and
was redone under a new checkpoint id. Not explained here; recorded because a
resume that silently discards completed work would be a cost bug, and the
arithmetic is the only place it showed up.

### F21 — spend attribution lags the response

`user.ts usage` read `$3.58` while `usage_event` summed to `$3.94`. Not a cap
defect: ingest runs *after* the response completes, so a figure read
mid-completion is stale. Worth knowing because the cap is a money control and a
stale read looks exactly like an undercount. After ingest the two agreed
exactly, and `unpricedEvents` stayed 0 throughout.

### Also observed

Server-side sessions survived the deliberate restart — the same cookie returned
**200** from `/api/me` afterwards.

---

## Round summary

| | Result | Cost |
|---|---|---|
| **V1** control generation | **VERIFIED** with findings | $1.7396 |
| **V2** add-section, live (7.6) | **VERIFIED** with findings | $0.0899 |
| **V3** page regen + revert, live (7.9) | **VERIFIED**, both claims | $0.5626 |
| **V4** fan-out-subprocess resume | **VERIFIED**; mechanism open (F19) | $1.5463 |
| | **Total** | **$3.9383** |

Against a ~$6 authorisation and a $2.72 estimate. 43 `usage_event` rows, **0
unpriced**, so the total is exact rather than a floor. The $5.00 stop-and-report
threshold was never approached.

**All three previously-unverified features work against a real model.** None of
the three was a false confidence: add-section produced a valid new section that
passed all seven gates including a real `tsc --noEmit`; page regeneration
regenerated every section and one revert restored the page byte-identically; and
a resume across a real multi-process crash completed at 31% of the original cost
without re-executing a single completed checkpoint.

### Defects found in the product

| | Severity | Status |
|---|---|---|
| **F13** `.regen-backup` is one global slot, not per-route — reverting route B after regenerating route A **deletes B and replaces it with A's files**, reachable over the authenticated HTTP surface | **Data loss** | Confirmed in code; fix queued |
| **F3** Every site ships `<title><UNKNOWN></title>` and `"name": "unknown"` into the handover export while the nav shows the real brand | Handover quality | Recorded; escalated |
| **F9** `add_section.py` writes no `sectionOrder` override and the HTTP API has **no position parameter at all**, so an API-only consumer can only append | Feature gap | Recorded |
| **F15** `regen-api.ts:7` documents `{ section \| route }`; line 215 destructures only `{ section }` | Doc/code mismatch in one file | Recorded |
| **F17** `manifest.json` key order is unstable across a regen — same keys, same byte count, different hash | Defeats hash-based change detection | Recorded |
| **F18** Zero prompt-cache reuse across the sequential page-regen loop | Cost is linear in sections | Recorded |
| **F20** Nine section checkpoints produced eight sections | Unexplained | Recorded |

### What this round says about the process, not the product

**Four of the errors found were in the verification plan itself**, and one would
have inverted a result: the plan's `md5sum home/*.tsx` matches only `index.tsx`
(components live in `home/sections/`), and on a tone-only instruction **no
component file changes at all** because copy lives in `mock/*.data.ts`. A worker
following the brief literally would have filed 7.9 as **broken**. It was caught
only because the assertion was re-derived from three independent signals —
distinct data files, mtimes in section order, and six billing rows with six
different token counts — rather than trusted.

The other three: `set-cap` takes `--usd` not `--cap`; `user.ts` resolves `--db`
relative to cwd (so the CLI and the server can silently use different
databases); and `WEBGEN_MASTER_KEY` is base64, not hex — where a hex key
*passes* the canonicality check and fails only on length, reporting `got 48`.

### Not done, deliberately

Wall clock (676.8s vs 349s predicted, over the 10-minute product ceiling) and
cost (58% over estimate on V1) are **measured and reported, not remediated** —
71% of the wall-clock miss is the sequential prelude, including a discarded
primitives retry worth 152.7s and $0.36. Per-section latency matched
`m7-wall-clock.md`'s model closely (29.2s vs 27.1s), so the earlier diagnosis
still holds and the lever is the prelude, not fan-out.

---

## Post-round fix: F13

Fixed in-round, per the round's rule that a proven-broken thing gets fixed when
the fix is contained. `.regen-backup/route.txt` now records the owning route,
and `restoreSnapshot` refuses a mismatched or unowned slot **before** any
destructive step. Five new tests; `npm run check` green.

**Per-route slots were rejected**, and the reason matters more than the fix: the
slot holds a whole-project `manifest.json` beside one route's page directory, so
two coexisting snapshots would let a revert of route A roll the manifest back
over route B's committed entries — trading cross-route file loss for cross-route
manifest loss. One slot keeps the page and manifest inside it paired.

**One of the five tests did not discriminate on first draft**, and it is recorded
because the same mistake is easy to repeat: it asserted
`existsSync(src/pages/about)`, which held with the guard disabled too, because
the destructive restore *recreated* the directory with the wrong contents.
Directory existence was never the property under test. Rewritten to assert the
snapshot slot survives a refused revert. Three of five now fail with the guard
disabled; the other two are non-discriminating by design — they prove the good
path still works.

**Not fixed, deliberately:** the refusal returns the handler's existing **500**
rather than a client-error status. A mismatched revert is a client-state
conflict and 409 would be more correct, but changing it is outside a data-loss
fix's blast radius. Recorded as a cosmetic follow-up.

## Still open after round 1

| | |
|---|---|
| **F3** `<UNKNOWN>` title + package name shipping into the handover export | Fix is contained; **confirming it costs another ~$1.74 generation** — needs a human call before spending |
| **F19** which mechanism carries fan-out resume (Kitaru cache vs `progress.json`) | Needs a run that inspects the filesystem *during* fan-out |
| **F20** nine section checkpoints produced eight sections | Unexplained |
| **H1** the orphaned orchestrator grandchild | **No evidence gained.** V4 killed the orchestrator tree directly, not a preview child — that path remains untested |
| **F9, F15 (status), F17, F18, F21** | Recorded above; none blocking |

---

## Independent review of the F13 fix

Dispatched because the F13 fix was authored by the session coordinator rather
than an implementer, so it had had **no independent review** — and because it
touches a destructive filesystem path. Verdict: **APPROVED_WITH_FINDINGS**,
0 Critical, 4 Important, 3 Minor.

### The review disproved the fix's own justification

The recorded reason for keeping ONE snapshot slot was that per-route slots would
trade cross-route *file* loss for cross-route *manifest* loss. **The reviewer
reproduced that manifest loss in the shipped single-slot design.**
`MAX_ACTIVE_JOBS_PER_USER` bounds concurrency per **user** (2), never per
project, so two regens on one project run together, share one preview child and
one unlocked slot; the second `snapshotRoute` wipes the first's slot, and a later
revert restores a manifest predating the first route's commit while that route's
code stays regenerated.

So it was never a trade-off. It is a defect under **both** designs, and per-route
slots would have been strictly better on the axis used to reject them. The
`docs/decisions.md` row carrying the wrong reasoning was **corrected rather than
rewritten**, because it was recorded as load-bearing and a future reader would
otherwise re-derive the same wrong conclusion.

**The shipped fix remains correct as far as it goes** — it closes the reproduced,
user-reachable file loss. It does **not** close manifest/code divergence under
concurrency, which needs a lock on the slot (the manifest service has a
cross-process file lock; the snapshot slot has none), per-project serialisation
of regen jobs, or per-route slots plus a manifest-merge strategy. **Open and
structural.**

### The same defect shape existed twice more in the same two functions

The pattern F13 *was* — a destructive step ahead of its validation — was fixed in
one place and left in two:

| | |
|---|---|
| **Finding 4** | `snapshotRoute` wiped the pending slot **before** checking the route had a page directory, so `{"route":"contact"}` — a valid slug with no directory — destroyed a legitimate snapshot and then threw, leaving the revert answering "no regeneration to revert" |
| **Finding 3** | `restoreSnapshot` checked that `.regen-backup/` existed but never `.regen-backup/page`, then deleted the target route before copying — destroying it with nothing left to restore from |
| **Finding 5** | The owner slug was `.trim()`ed on read with no matching write-side normalisation, so `" home"` and `"home"` compared equal |

**Finding one instance is not finding the pattern.** All three fixed; all four new
tests confirmed to fail with their guards disabled.

### Finding 2 — the only client could not see the refusal

`App.tsx`'s `revertRegen` used a bare `fetch` with no `.ok` check and not
`sessionAwareFetch`, so a guard refusal rendered as a **successful** revert:
affordance cleared, orphan list cleared, preview reloaded, nothing changed on
disk. The same class of lie as the autosave "Saved" bug — and made reachable by
the guard itself, since a failed regen on another route reassigns the slot while
leaving `revertSection` pointing here. Fixed; `revertSection` and the orphan list
are deliberately **left in place** on failure so the affordance does not vanish.

### Minor findings, recorded not fixed

- **6** Exporting both helpers for tests dropped the structural guarantee that
  every caller validates first; `snapshotRoute` can still copy from outside the
  project root, with the destructive half protected only incidentally by
  `.split(".")[0]` yielding `""` for `..`.
- **7** An unowned or foreign-owned slot can only be cleared by another billable
  regen — no discard endpoint, and a hosted user has no filesystem access.
