# Round 1: Live Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove — against a real model, over the real hosted HTTP path — that add-section (7.6), page regeneration (7.9) and fan-out-subprocess resume actually work, and fix whatever that proves broken.

**Architecture:** One `server/scripts/serve.ts` instance, one operator-created user with a real Anthropic key, every verification driven as an authenticated HTTP request exactly as a browser would. Faults are induced by killing the real `uv run python` process tree — no production code is modified to make a verification easier. Four runs in cheapest-failure-first order, each reporting actual spend read from `usage_event` rather than estimated.

**Tech Stack:** Node 24 (`node:sqlite`), `server/` composition root, `compiler/` preview + regen API, Python 3.12 / uv / Kitaru 0.21.0 orchestrator, curl for HTTP, PowerShell for process-tree control on Windows.

**Spec:** [docs/superpowers/specs/2026-08-10-post-slice-5-hardening-design.md](../specs/2026-08-10-post-slice-5-hardening-design.md)

## Global Constraints

- **Budget: ~$6 total authorised.** Expected spend ~$2.72. Read actual spend from `usage_event` after **every** run, never at the end only. If cumulative spend passes $5, stop and report before starting another run.
- **No production code may be changed to make a verification easier.** If a verification cannot be run without one, that is a finding about the design — report it, do not work around it.
- **Fix what is proven broken; stop and escalate anything structural.** A fix that requires a redesign halts the round and comes back to the human with the evidence.
- **Every fix gets a regression test that fails without the fix.** Perturb it, watch it fail, restore. **If a perturbation does not fail, say so** rather than moving on.
- **Report everything verbatim, including anything that merely looked odd.** A verification that did not behave as expected is a finding, not something to smooth over.
- **No HTTP route may create a user.** `server/src/user-cli.ts` stays the only path to an account.
- **Nothing may log or persist API-key material.** Only a last-4 fingerprint may appear in output.
- **Passwords are never accepted as CLI arguments** — `user-cli create` generates and prints one, once.
- `WEBGEN_MASTER_KEY` must be set or the server refuses to boot; `serve.ts` deletes it from `process.env` after reading.
- **Never modify `docs/` to make code pass.** Appending a `docs/decisions.md` row is required and is not a violation.
- **`generated/` is disposable; never hand-patch generated files.** Fix generation-quality problems in the template or the contract enforcement.
- Red tests never cross a commit boundary. `npm run check` must be green before the round is declared done.
- Scratch files (cookie jars, response bodies, logs) go in the session scratchpad, never in the repo.

## Reference: the exact HTTP and CLI surface

Verified against the code on 2026-08-10. Use these shapes verbatim.

| What | Shape |
|---|---|
| Create user | `node server/scripts/user.ts create --email <email> --db "$DB"` → prints a generated password once |
| Set spend cap | `node server/scripts/user.ts set-cap --email <email> --usd 20 --db "$DB"` |
| Read spend | `node server/scripts/user.ts usage --email <email> --db "$DB"` |
| Boot server | `WEBGEN_MASTER_KEY=<canonical padded base64, 32 bytes> node server/scripts/serve.ts --port 4000 --db "$DB" --projects-root ./generated` |
| Login | `POST /api/login` `{ "email", "password" }` — **`Content-Type: application/json` is required** (it is what closes login-CSRF) |
| Store key | `PUT /api/key` `{ "apiKey": "sk-ant-…" }` → `{ fingerprint }` |
| Generate | `POST /api/generate` `{ "brief": "…" }` → **202** `{ jobId, projectId }` |
| Add section | `POST /__add-section?project=<id>` `{ "route", "archetype", "instruction" }` → 202 `{ jobId }` |
| Regen page | `POST /__regen-page?project=<id>` `{ "route", "instruction" }` → 202 `{ jobId }` |
| Revert | `POST /__regen-revert?project=<id>` `{ "route" }` → `{ ok }` |
| Archetypes | `GET /__archetypes?project=<id>` → `{ archetypes: [{name, description}] }` |
| Poll job | `GET /api/jobs/:id` |
| Resume | `POST /api/jobs/:id/resume` → 202; **409 if the job is not `failed`**; 409 on a `code_version` mismatch |
| Run report | `uv run --directory orchestrator python -m orchestrator.run_report <run_id> -o <out>.html` |
| Run log path | `uv run --directory orchestrator python -c "from orchestrator.runlog import default_run_log_path; print(default_run_log_path('<run_id>'))"` |

**Two traps in that table, both found by reading the code rather than assuming.**

`set-cap` takes **`--usd`**, not `--cap` (`server/src/user-cli.ts:101`). A wrong flag name throws `--usd must be a non-negative number`, which reads like a bad *value* rather than a bad *name*.

**`$DB` must be an absolute path, given explicitly to every command.** `user.ts` defaults to `./data/identity.db` **relative to cwd** (`server/scripts/user.ts:15`), so invoking it via `npm run -w server` (cwd `server/`) and running the server from the repo root resolve the *same* default string to two different files. The failure is quiet and expensive: the CLI creates the user in one database, the server reads another, and login returns the deliberately uniform auth failure with no hint that two files exist. Invoke both with `node` from the repo root, and set the path once:

```bash
export DB="$PWD/server/data/identity.db"
```

**THE TRAP, repeated from `CLAUDE.md` because it will bite:** `succeeded` means *the request completed*, not that the work passed. A gate failure arrives as a `succeeded` job whose `result.passed` is `false`. Every assertion below that says "succeeded" means **`status === "succeeded"` AND `result.passed !== false`**.

**Corrected by V1's live run — `$PROJECT_ID` is NOT a directory name.** A project's id and its on-disk directory are **two different UUIDs by design**: the API returns the id (`ba169e65-…`), while the directory is the run id (`web-2578801a-…`). `generated/$PROJECT_ID` does not exist. So:

- **HTTP** always takes the project **id**: `?project=$PROJECT_ID`.
- **Filesystem** paths always take the run directory: `generated/$RUN_DIR`.
- `GET /api/jobs/:id` does **not** expose `run_id` (`publicJobView` omits it). Get the directory from `node server/scripts/user.ts list-projects --email <email> --db "$DB"`, which prints it.

**Corrected again by V2's live run — the success field differs per endpoint, and getting it wrong passes a failure straight through:**

| Endpoint kind | Success field |
|---|---|
| `/__regen`, `/__regen-page`, `/__add-section`, `/__edit-prompt` | **`passed`** |
| `/__export` | **`ok`** — a gate failure returns HTTP 200 + `{ok:false}`, which `job-worker.ts:1123` maps to a `succeeded` job |
| `generate` | **neither** — result is `{ stdout }`; a gate failure surfaces as a `failed` job |

So `result.passed !== false` is *vacuously true* for an export that failed its gates. Check the right field for the endpoint you called.

**Also corrected: `result.passed` does not exist on a `generate` job** — its result is `{ stdout }` only, so `result.passed !== false` is vacuously true there. THE TRAP is real for the five **proxied** kinds (Tasks 3 and 4) and inapplicable to V1/V4. For `generate`, a gate failure surfaces as a `failed` job instead, because `acceptance.py` raises on a non-zero exporter exit.

---

### Task 1: Stand up the harness (no model spend)

**Files:**
- Create: `<scratchpad>/harness.md` — the run journal, appended to by every later task
- Modify: none

**Interfaces:**
- Produces: a booted server on port 4000, a logged-in cookie jar at `<scratchpad>/cookies.txt`, `$EMAIL`, `$PROJECT_ID` (unset until Task 2), and `harness.md` recording the master key's provenance (never its value)

- [ ] **Step 1: Confirm a clean starting point**

```bash
cd "c:/Users/Dilip/Documents/GitHub/website generator"
git status --porcelain          # expect empty
node --version                  # expect >= 22.13 (node:sqlite)
uv --version
```

- [ ] **Step 2: Generate a master key and record its provenance, not its value**

```bash
export WEBGEN_MASTER_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
echo "master key: generated fresh for this round, 32 random bytes, base64" >> "$SCRATCH/harness.md"
```

**It must be `base64`, not `hex`** (`server/src/master-key.ts:40`) — and a hex string fails in a way worth understanding, because the same shape will catch anyone who guesses. Hex characters are all inside the base64 alphabet and 64 of them need no padding, so a 64-char hex key **passes** the canonical-base64 check at line 41 and is caught only by the length check at line 48, reporting `got 48` rather than "that's hex". Exactly what that function's own comment says it is for.

The key must **persist for the whole round**: once the Anthropic key is encrypted under it, a restart with a different one cannot decrypt it, and Task 5 Step 7 restarts the server deliberately. Keep it in a session-scoped scratchpad env file (never the repo), and record in the journal that you did.

If an identity database already exists from earlier work, **a fresh master key cannot decrypt its stored keys.** Either reuse the original key or start a fresh `--db` path. Record which you did.

- [ ] **Step 3: Create the user and raise the cap above the round's budget**

```bash
node server/scripts/user.ts create --email verify-round1@local.test --db "$DB"
# capture the printed password into the scratchpad, NOT into the repo
node server/scripts/user.ts set-cap --email verify-round1@local.test --usd 20 --db "$DB"
```

The cap must exceed ~$6 or a later run is refused with **402** partway through and the round stalls with money already spent.

- [ ] **Step 4: Boot the server in the background**

```bash
node server/scripts/serve.ts --port 4000 --db "$DB" --projects-root ./generated
```

`--projects-root` must resolve to the orchestrator's own `generated/` or the worker **refuses to boot** by design. A non-zero exit here is the guard working, not a bug.

- [ ] **Step 5: Log in and confirm the session**

```bash
curl -s -c "$SCRATCH/cookies.txt" -X POST http://localhost:4000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"verify-round1@local.test","password":"<printed>"}'
curl -s -b "$SCRATCH/cookies.txt" http://localhost:4000/api/me
```

Expected: `/api/me` returns the user. Omitting `Content-Type: application/json` on login **must** fail — try it once and record the result; that header is what closes login-CSRF.

- [ ] **Step 6: Store the real Anthropic key**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X PUT http://localhost:4000/api/key \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-ant-…"}'
```

Expected: `{ "fingerprint": "…" }`. **Only the fingerprint may be echoed into `harness.md`.**

- [ ] **Step 7: Confirm zero spend before any run**

```bash
node server/scripts/user.ts usage --email verify-round1@local.test --db "$DB"
```

Expected: `$0.00 spent of $20.00`. This is the baseline every later delta is measured against.

- [ ] **Step 8: Commit the journal scaffold**

The journal lives in the scratchpad and is **not** committed. Commit nothing in this task; it changes no repository file. Record in `harness.md` that Task 1 completed and the server PID.

---

### Task 2: V1 — control generation (~$1.10)

**Files:**
- Create: `docs/reports/m8-live-verification.md` (started here, appended by Tasks 3–5)
- Modify: none unless a defect is found

**Interfaces:**
- Consumes: the harness from Task 1
- Produces: `$PROJECT_ID` and `$RUN_ID` for Tasks 3–4; a fresh, known-good generated site

- [ ] **Step 1: Enqueue a clean generation**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST http://localhost:4000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"brief":"A three-page marketing site for a small-batch coffee roaster: home, about, and pricing."}'
```

Expected: **202** with `{ jobId, projectId }`. Record both. Note the wall-clock start time.

- [ ] **Step 2: Confirm the project row and directory exist immediately**

```bash
node server/scripts/user.ts list-projects --email verify-round1@local.test --db "$DB"
ls "generated/$RUN_DIR"
```

Expected: both exist **before the job has run** — that is the design ("a failed generation leaves an owned, deletable project rather than an orphan"). An empty directory at this moment is correct, not a failure.

- [ ] **Step 3: Poll to a terminal state**

```bash
curl -s -b "$SCRATCH/cookies.txt" "http://localhost:4000/api/jobs/$JOB_ID"
```

Poll every 15s. Expected terminal state: `status === "succeeded"` **and** `result.passed !== false`. Record wall clock.

- [ ] **Step 4: Read actual spend, not an estimate**

```bash
node server/scripts/user.ts usage --email verify-round1@local.test --db "$DB"
```

Record the delta from Task 1's baseline. **If the `unpriced events` note appears, the figure is a floor** — say so in the report rather than quoting it as the total.

- [ ] **Step 5: Verify the site is real**

```bash
ls "generated/$RUN_DIR/src/pages"          # expect 3 route directories
find "generated/$RUN_DIR/src/pages" -name "*.tsx" | wc -l
```

Then open the preview and confirm it renders with node ids present:

```bash
curl -s -b "$SCRATCH/cookies.txt" "http://localhost:4000/preview/$PROJECT_ID/" | grep -c "data-node-id"
```

Expected: a non-zero count. **Zero with HTTP 200 is the exact 4c-1 failure mode** (a missing `basename` made React Router match nothing while the shell still drew nav and footer) — if you see it, that is a finding, not a flake.

- [ ] **Step 6: Compare wall clock against the model, not the raw baseline**

`docs/reports/m7-wall-clock.md` measured **286s for 4 routes / 8 sections**; slice 5's live run was **401.8s for 10 sections across 3 routes**. Fewer routes means fewer parallel workers and more sections serialized per worker. That report's own model is a **~149s sequential prelude plus ~13s/section of contention**, with per-section model latency only **27s**.

Compute the predicted wall clock for *this* run's shape from that model and compare against it. **A number above 286s is not by itself a regression.** Record the prediction, the actual, and the gap.

- [ ] **Step 7: Start the report**

Create `docs/reports/m8-live-verification.md` with a V1 section: brief used, jobId, projectId, runId, wall clock (predicted vs actual), actual cost, section count, and every assertion with its result.

- [ ] **Step 8: Commit**

```bash
git add docs/reports/m8-live-verification.md
git commit -m "docs(report): V1 control generation, live"
```

**If V1 fails:** stop. A broken happy path invalidates Tasks 3–5, which run against its output. Report before spending anything further.

---

### Task 3: V2 — add-section against a live model (~$0.12)

**Files:**
- Modify: `docs/reports/m8-live-verification.md`

**Interfaces:**
- Consumes: `$PROJECT_ID` from Task 2
- Produces: a site with one appended section, for Task 4 to regenerate around

- [ ] **Step 1: Read the real archetype catalog**

```bash
curl -s -b "$SCRATCH/cookies.txt" "http://localhost:4000/__archetypes?project=$PROJECT_ID"
```

Pick an archetype **that the generated site does not already use on the target route**, so the assertion in Step 4 is unambiguous. Record which and why.

- [ ] **Step 2: Record the pre-state**

```bash
cat "generated/$RUN_DIR/overrides/home.overrides.json" 2>/dev/null
ls "generated/$RUN_DIR/src/pages/home"
```

Capture the current `sectionOrder` override (or its absence) and the section file list. Task 3's central claim is a *diff* against this.

- [ ] **Step 3: Add the section**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/__add-section?project=$PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"route":"home","archetype":"<the archetype chosen in Step 1>","instruction":"Answer common questions about shipping, subscriptions, and bean freshness."}'
```

`faq-accordion` is the likely choice for a coffee-roaster home page, but **Step 1 governs** — if the generated site already used it on `home`, pick another from the catalog and adjust the instruction to match. Record which you used.

Expected: **202** `{ jobId }`. Poll to terminal.

- [ ] **Step 4: Assert what only a live run can show**

This is a **first generation, not a replay** — the section never existed, which is precisely what mock mode cannot exercise. Assert each separately:

1. `status === "succeeded"` **and** `result.passed !== false`.
2. A new `.tsx` file exists under `src/pages/home/` that did not exist in Step 2.
3. The new section is registered in `manifest.json` with semantic (never positional) node ids.
4. A `sectionOrder` override now exists for `home` and **names every section on the route, not just the new one** — a partial order is a hard export failure by design, because an omitted section would silently vanish.
5. The site plan reflects the new section.

- [ ] **Step 5: Prove it survives export — all seven gates**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/__export?project=$PROJECT_ID"
```

Poll to terminal. Expected `succeeded` with `result.passed === true`. Gate 1 now runs the project's own `tsc --noEmit`, so this is a real compile of live-generated code, not a lint.

- [ ] **Step 6: Read spend and append to the report**

```bash
node server/scripts/user.ts usage --email verify-round1@local.test --db "$DB"
```

Append a V2 section recording every assertion above with its result, the actual cost delta, and the archetype chosen.

- [ ] **Step 7: Commit**

```bash
git add docs/reports/m8-live-verification.md
git commit -m "docs(report): V2 add-section, live"
```

---

### Task 4: V3 — page regeneration and revert against a live model (~$0.40)

**Files:**
- Modify: `docs/reports/m8-live-verification.md`

**Interfaces:**
- Consumes: `$PROJECT_ID` from Task 2, with Task 3's added section in place

- [ ] **Step 1: Record the pre-state of every section on the route**

```bash
md5sum generated/$RUN_DIR/src/pages/home/*.tsx > "$SCRATCH/home-before.txt"
cat "$SCRATCH/home-before.txt"
```

Per-file hashes, not a directory listing. Step 3's central assertion is that **each** file changed — a single hash of the directory could not distinguish "all six regenerated" from "one rewritten six times".

- [ ] **Step 2: Regenerate the page**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/__regen-page?project=$PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"route":"home","instruction":"Warmer, more personal tone throughout; keep all facts and structure."}'
```

Expected: **202** `{ jobId }`. Poll to terminal. The response carries `sections` and `perSection`.

- [ ] **Step 3: Assert each section was actually regenerated**

```bash
md5sum generated/$RUN_DIR/src/pages/home/*.tsx > "$SCRATCH/home-after.txt"
diff "$SCRATCH/home-before.txt" "$SCRATCH/home-after.txt"
```

Assert:
1. **Every** section file's hash changed — not one file N times. Mock regen once hardcoded `Hero`, which would have reported six sections done while rewriting one file six times; this is the check that catches that class.
2. `perSection` reports one entry per section on the route, and its count matches the file count.
3. Node ids survived: every `[data-node-id]` present before is present after. Compare against `manifest.json`.
4. No orphaned overrides were reported.

- [ ] **Step 4: Assert one revert restores the whole page**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/__regen-revert?project=$PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"route":"home"}'
md5sum generated/$RUN_DIR/src/pages/home/*.tsx > "$SCRATCH/home-reverted.txt"
diff "$SCRATCH/home-before.txt" "$SCRATCH/home-reverted.txt"
```

Expected: **byte-identical to Step 1**, from the single route-wide snapshot taken before the first section. An empty diff is the pass condition. Anything else is a finding.

- [ ] **Step 5: Read spend and append to the report**

```bash
node server/scripts/user.ts usage --email verify-round1@local.test --db "$DB"
```

- [ ] **Step 6: Commit**

```bash
git add docs/reports/m8-live-verification.md
git commit -m "docs(report): V3 page regeneration and revert, live"
```

---

### Task 5: V4 — fan-out-subprocess resume (~$1.10 + a cheap resume)

**Files:**
- Modify: `docs/reports/m8-live-verification.md`
- Create: one `docs/decisions.md` row recording the empirical finding, whichever way it goes

**Interfaces:**
- Consumes: the harness from Task 1
- Produces: the answer to the one open question with genuine doubt

**Why the fault must hit the orchestrator, not the server:** resume requires `original.status === "failed"` ([job-routes.ts:348](../../../server/src/job-routes.ts#L348)), and a `generate` job reaches `failed` only when `orchestrator.acceptance` exits non-zero. Killing the **server** produces `interrupted`, which is deliberately never retried and not resumable.

> **DO NOT RESTART THE SERVER BETWEEN STEP 1 AND STEP 6 OF THIS TASK.** `resolveCodeVersion` is called **once, at boot** (`server/scripts/serve.ts:119`) and threaded from there — verified in code after V1's run. So ordinary commits during the task are **harmless**: the running server stays pinned to whatever HEAD was when it started, and the round's server is already pinned to `05d5360`, several commits behind. What *is* load-bearing is a **restart**: a server that comes back up re-reads HEAD, and every resume of a job recorded under the old sha is then refused **409** — the guard working exactly as designed, but indistinguishable at a glance from the feature being broken. Step 7's deliberate restart is therefore the LAST resume-related action in this task; if you must restart earlier, pin `WEBGEN_CODE_VERSION=05d53603e7ba1bcfb0f862f9ef058717e43082e9` on the way back up.

- [ ] **Step 1: Start a second generation**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST http://localhost:4000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"brief":"A three-page storefront for a independent bookshop: home, catalogue, and visit-us."}'
```

Record `jobId`, `projectId`. Note the `runId` from the job row — Step 5 needs it.

- [ ] **Step 2: Wait until fan-out is genuinely under way**

Watch the run log until **at least one `section.generated` event** has been written:

```bash
LOG=$(uv run --directory orchestrator python -c "from orchestrator.runlog import default_run_log_path; print(default_run_log_path('$RUN_ID'))")
grep -c "section.generated" "$LOG"
```

Do not kill before this is ≥ 1: with nothing cached, the resume proves nothing. Record the count at kill time — it is the exact number Step 6 asserts was replayed.

- [ ] **Step 3: Kill the whole orchestrator process tree**

```powershell
$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*orchestrator.acceptance*' }
$p | Select-Object ProcessId, CommandLine
taskkill /T /F /PID $p.ProcessId
```

`/T` is **required**: page workers are subprocesses, and killing only the parent leaves them running. Record whether any survived — that is pending item H1's exact shape, and this step may produce free evidence about it.

- [ ] **Step 4: Confirm the job landed `failed`, not `interrupted`**

```bash
curl -s -b "$SCRATCH/cookies.txt" "http://localhost:4000/api/jobs/$JOB_ID"
```

Expected: `failed`. **If it lands `interrupted` or stays `running`, stop and report** — that would mean a real orchestrator crash in production is not resumable either, which is precisely what the feature claims to handle. That outcome is a finding worth having, not a setup problem to hack around.

- [ ] **Step 5: Resume**

```bash
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/api/jobs/$JOB_ID/resume"
```

Expected: **202** with a new `jobId`. Poll to terminal.

- [ ] **Step 6: Assert replay, not re-execution — each separately**

1. The new job's `run_id` **equals** the original's. (Reusing the run id *is* the resume mechanism; there is no separate Kitaru resume API.)
2. **No new `section.generated` events** for sections already recorded at Step 2's kill time. Count them in the run log and compare against Step 2's number.
3. Only the incomplete work ran again.
4. **The resume's ingested cost is far below the first attempt's.** This is the economic signature of a real replay and the one check a log line cannot fake — a resume that silently re-executed everything would cost roughly the same as the original.
5. `page_worker.py` skipped already-recorded sections from `progress.json` across the subprocess boundary.

Assertions 2 and 4 must **agree**. If the log says replayed but the cost says re-executed, trust the cost and report the discrepancy — the money is the ground truth.

- [ ] **Step 7: Confirm the code-version guard**

```bash
WEBGEN_CODE_VERSION=deliberately-different  # restart the server with this set
curl -s -b "$SCRATCH/cookies.txt" -X POST "http://localhost:4000/api/jobs/$JOB_ID/resume"
```

Expected: **409**. Restart without the override afterwards.

- [ ] **Step 8: Generate the DAG report for the record**

```bash
uv run --directory orchestrator python -m orchestrator.run_report "$RUN_ID" -o "$SCRATCH/$RUN_ID-report.html"
```

- [ ] **Step 9: Record the finding either way, naming the Kitaru version**

Append a V4 section to the report and add one `docs/decisions.md` row. **State that the finding is valid for Kitaru 0.21.0** (pinned exactly in `orchestrator/uv.lock`; `pyproject.toml` only declares `>=0.21.0`), because nothing in CI re-verifies this behaviour against a future upgrade.

Note in the report which of the two independent mechanisms carried the weight: Kitaru's checkpoint cache, or `page_worker.py`'s file-based `progress.json` skip. They are independent, and only a real multi-process run distinguishes them.

- [ ] **Step 10: Commit**

```bash
git add docs/reports/m8-live-verification.md docs/decisions.md
git commit -m "docs(report): V4 fan-out-subprocess resume, live"
```

---

### Task 6: Close the round

**Files:**
- Modify: `docs/reports/m8-live-verification.md`, `docs/decisions.md`

- [ ] **Step 1: Report total actual spend against the authorisation**

```bash
node server/scripts/user.ts usage --email verify-round1@local.test --db "$DB"
```

State the total against the ~$6 ceiling and the ~$2.72 estimate. If the `unpriced events` note appeared at any point, say the figure is a floor.

- [ ] **Step 2: Confirm no orphaned processes hold a port**

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*vite*' -or $_.CommandLine -like '*orchestrator*' } | Select-Object ProcessId, CommandLine
```

Expected: none. Any survivor is a finding — and if it descends from Step 3's kill, it is direct evidence for pending item H1.

- [ ] **Step 3: Run the full gate**

```bash
npm run check
```

Expected: green. Red tests never cross a commit boundary.

- [ ] **Step 4: Write the summary**

For each of V1–V4: **verified**, **verified with findings**, or **blocked** — and for anything not verified, say plainly what remains unproven rather than implying coverage. List every defect found, whether it was fixed or escalated, and why.

- [ ] **Step 5: Commit**

```bash
git add docs/reports/m8-live-verification.md docs/decisions.md
git commit -m "docs(report): close the live-verification round"
```

---

## What this round does not do

- **No fix for H1 (the orphaned grandchild)**, even though Task 5 may produce evidence about it. The fix means propagating termination through the Vite child — `compiler/` territory, and a separate decision.
- **No `--out-dir` threading (H6)**, though Task 2 stands up the live harness its eventual verification will need.
- **No docs corrections (H7)**, including `CLAUDE.md`'s two stale claims, unless separately approved.
- **Nothing from D1–D3** (cross-origin preview, OS-level isolation, the UI slice).

## On finding a bug

Expected, not exceptional: 5.5's first live run found five, 6.4 found five more, and 7.1 found regeneration broken for 19 of 20 archetypes. For each:

1. Record it in the report with the evidence that proved it — verbatim.
2. If the fix is contained, fix it, add a regression test that **fails without the fix** (perturb, watch it fail, restore), and commit.
3. If the fix needs a redesign, **stop the round** and report with the evidence. Do not attempt it.
4. Fix generation-quality problems in the template or the contract enforcement — **never by hand-patching `generated/`.**
