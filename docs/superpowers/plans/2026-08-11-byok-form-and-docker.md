# BYOK Form + Docker Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tester enters their API key in the browser and starts the whole stack with `docker compose up`, instead of running two curl commands and installing four toolchains.

**Architecture:** Provider-aware key storage on the server (append-only migration + per-provider shape validation + provider-aware agent env), a settings form in the existing editor app, and one container image carrying Node + Python + uv with volumes for `generated/` and the identity database. The README becomes Docker-first while keeping the from-source path intact.

**Tech Stack:** React 19 + Vite + TS (`editor/`), Node 24 + `node:sqlite` (`server/`), Python 3.12/uv/Kitaru (`orchestrator/`), Docker Compose.

**Prior art:** [docs/pending.md](../../pending.md) is the live pending list — update it as items close. [README.md](../../../README.md) exists and was verified by a literal clean-shell follow; do not regress it.

## Global Constraints

- **No HTTP route may create a user.** Account creation exists **only** in `server/src/user-cli.ts`. Under Docker this becomes `docker compose exec`, which **preserves** the property — invite-only is structural, not an inconvenience. The form carries no sign-up and no password-reset link.
- **Nothing may log or persist API-key material.** Only a last-4 fingerprint may reach the UI or any log. `getApiKeyFingerprint` takes no master key, so a display-only caller is structurally incapable of decrypting — keep it that way.
- **`WEBGEN_MASTER_KEY` is canonical padded base64, not hex**, and the app refuses to boot without it. **It must persist across container restarts**: a fresh key makes every already-stored API key permanently undecryptable. Generate once, keep it in an env file, never bake it into an image.
- **`serve.ts` deletes `WEBGEN_MASTER_KEY` from `process.env` immediately after reading it**, because `compiler/`'s three spawn sites pass no `env` and would otherwise inherit it into model-generated build config. Do not undo that.
- **Local mode must stay byte-identical.** `compiler/scripts/preview.ts` stays unauthenticated and local. No file under `editor/e2e/` may change, no Playwright config, no assertion weakened.
- **Migrations are append-only and idempotent.** Do not edit an existing migration.
- **Every new endpoint must appear in `server/src/project-registry.ts`**, a partition of the live route table.
- **Any client- or model-influenced string reaching a path, URL, or spawn argument is a `..` hazard.** Four such defects have shipped at four layers of this repo; one latent instance is already recorded. Assume a fifth.
- **Name editor test files `.test.ts`, never `.test.tsx`.** The vitest glob once matched `.test.ts` only, so a `.test.tsx` file was silently skipped — coverage that never runs, which perturbation cannot detect.
- **A substring assertion is not a discriminating assertion.** `toThrow(/msg/)` still passes when the message is perturbed by appending. Assert exact strings where wording is the point.
- No new **runtime** dependencies in `server/`, `compiler/` or `editor/`. Docker config is not a runtime dependency.
- Red tests never cross a commit boundary. `npm run check` green before each commit.
- **Every test must fail if the behaviour it names is removed.** Perturb, watch the named assertion fail, restore. **If a perturbation does not fail, say so** rather than moving on.

## The accepted risk this plan ships, stated once

**Gemini spend is not bounded by the spend cap.** `orchestrator/src/orchestrator/pricing.py` has no Gemini rates — its own comment names `gemini-flash-latest` as the example of a model whose tokens produce no cost — so a Gemini run writes `cost_usd = NULL` and `checkSpendCap`'s total becomes a **floor**, not a total. This was accepted deliberately in favour of shipping both providers. The mitigation, and it is required rather than optional: **`unpricedEvents` must be surfaced prominently wherever spend is shown**, so a tester can see their figure is a floor. `/api/me` already returns it.

---

### Task 1: Provider-aware key storage

**Files:**
- Modify: `server/src/db.ts` (append a migration), `server/src/keys.ts`, `server/src/key-routes.ts`, `server/src/agent-env.ts`
- Test: `server/src/keys.test.ts`, `server/src/key-routes.test.ts`, `server/src/agent-env.test.ts`

**Interfaces:**
- Produces: `setApiKey(db, masterKey, userId, apiKey, provider)`; `getApiKeyFingerprint(db, userId)` → `{fingerprint, provider} | null`; `PUT /api/key` accepting `{apiKey, provider}`

- [ ] **Step 1: Write the failing tests**

```ts
it("stores a Gemini key and reports its provider back", () => {
  setApiKey(db, masterKey, userId, "AIzaSyIsNotARealKeyJustTheRightShape123", "gemini");
  expect(getApiKeyFingerprint(db, userId)).toEqual({ fingerprint: "e123", provider: "gemini" });
});

it("rejects an Anthropic-shaped key submitted as gemini, and vice versa", async () => {
  // The shape and the declared provider must agree, or the agent gets a key
  // the provider will reject 401 AFTER the job is queued and billed.
  expect(() => setApiKey(db, masterKey, userId, "sk-ant-aaaaaaaaaaaaaaaaaaaaaa", "gemini")).toThrow();
});
```

- [ ] **Step 2: Run them and watch them fail** — `npx vitest run server/src/keys.test.ts`

- [ ] **Step 3: Implement**

Append a migration adding `provider TEXT NOT NULL DEFAULT 'anthropic'` to the key table. **The default is what makes it idempotent and backward-compatible**: every existing row is an Anthropic key, and nothing needs rewriting.

Validate per provider. Anthropic stays `/^sk-ant-[A-Za-z0-9_-]{20,}$/` — do not loosen it. For Gemini, **verify the real shape yourself** (Google AI Studio keys are conventionally `AIza` followed by 35 URL-safe characters) and write down what you verified and where. **The declared provider and the key's shape must agree**, because a mismatch surfaces as a provider 401 *after* the job is queued.

In `agent-env.ts`: an Anthropic key still sets `ANTHROPIC_API_KEY`; a Gemini key sets **`GEMINI_API_KEY` and `ORCH_MODEL_PROVIDER=gemini`** (the orchestrator's existing opt-in escape hatch). Keep deleting the host's inherited keys first — that deletion is why `orchestrator/.env` cannot leak into a user's run, and it must now cover **both** variables.

- [ ] **Step 4: Tests pass, then perturb**

Remove the shape/provider agreement check — a named test must fail. Stop deleting the inherited `GEMINI_API_KEY` — a named test must fail. Return the provider without the fingerprint — a test must fail. **Name which tests failed.**

- [ ] **Step 5: Commit** — `feat(server): store an API key per provider`

---

### Task 2: The key form, and spend that admits when it is a floor

**Files:**
- Create: `editor/src/components/KeySettings.tsx`, `editor/src/components/KeySettings.test.ts`
- Modify: `editor/src/App.tsx`, `editor/src/lib/backend.ts`, `editor/src/components/ProjectPicker.tsx`, `editor/src/App.css`

**Interfaces:**
- Consumes: `GET /api/key` → `{fingerprint, provider} | null`; `PUT /api/key` `{apiKey, provider}`; `DELETE /api/key`; `GET /api/me` → `{spendCapUsd, spentUsd24h, unpricedEvents, …}`
- Produces: `<KeySettings onSaved={() => void}>`, `export function submitKey(apiKey, provider, options?)`

- [ ] **Step 1: Write the failing tests**

```ts
it("never renders the key it just submitted, only the fingerprint the server returned", async () => {
  const secret = "sk-ant-aaaaaaaaaaaaaaaaaaaaaa";
  const fetchImpl = async () => new Response(JSON.stringify({ fingerprint: "aaaa" }), { status: 200 });
  const result = await submitKey(secret, "anthropic", { fetchImpl });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("says the spend figure is a FLOOR when any event was unpriced", () => {
  expect(describeSpend({ spendCapUsd: 10, spentUsd24h: 1.74, unpricedEvents: 3 }))
    .toMatch(/at least/i);
  expect(describeSpend({ spendCapUsd: 10, spentUsd24h: 1.74, unpricedEvents: 0 }))
    .not.toMatch(/at least/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

A form with a provider selector and a password-type key field. Show the stored key as `provider · ••••fingerprint` with a Replace and a Remove action. **The key must never be echoed, held in state after submit, or logged** — only the returned fingerprint.

Reachable from the project picker **and** shown automatically when no key is stored, because the alternative is discovering it after pressing a button that spends money.

**`describeSpend` is the accepted-risk mitigation and is not optional.** When `unpricedEvents > 0` the wording must say the spend is *at least* that much — a Gemini run produces no cost figure, so the cap is a floor. Use it everywhere spend is shown, including the picker's budget line.

- [ ] **Step 4: Tests pass, then perturb**

Echo the submitted key back in the result — the first test must fail. Make `describeSpend` ignore `unpricedEvents` — the second must fail. **Name them.**

- [ ] **Step 5: Commit** — `feat(editor): add an API-key form with provider choice`

---

### Task 3: One image, one command

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `docker/entrypoint.sh`
- Modify: `.gitignore` (an env file holding the master key must never be committed)

- [ ] **Step 1: Establish the real version floors before writing anything**

`server/package.json` declares `engines.node >= 22.13` for `node:sqlite`, **but every entry point is a `.ts` file run directly by `node`**, which needs unflagged type stripping — **22.18+**. Verify both claims yourself and record what you checked. The orchestrator needs Python 3.12 and `uv`, and the server **spawns `uv run python`**, so both must be in the image, not just at build time.

- [ ] **Step 2: Write the Dockerfile**

One image carrying Node, Python 3.12 and `uv`. Install dependencies in a layer above the source copy so a source edit does not re-resolve them. **Do not bake any secret into the image.**

- [ ] **Step 3: Write `compose.yaml`**

- Ports: `4000` (server) and `5173` (editor dev server). Preview children are spawned internally and reached through the server's proxy, so they need **no** port mapping.
- **Volumes for `generated/` and the identity database.** `generated/` holds real work; the database holds accounts and encrypted keys. Losing either is losing the tester's data.
- Use anonymous volumes for `node_modules` so a host bind-mount does not shadow the installed tree — the usual Windows/macOS trap.
- `WEBGEN_MASTER_KEY` comes from an env file, **generated once by the tester**. Document that regenerating it makes stored keys undecryptable.
- `--projects-root` must resolve to the orchestrator's own `generated/`, or the worker **refuses to boot** by design. In a container this is a fixed path, so pass it explicitly and note that the refusal is a guard, not a bug.

- [ ] **Step 4: Verify by running it, not by inspection**

`docker compose up`, then: create an account with `docker compose exec`, log in through a browser, save a key through the new form, and confirm the project picker renders. **Do not run a generation** (~$1.74, ~11 min). Then `docker compose down && docker compose up` and confirm **the account still exists and the stored key still decrypts** — that is the master-key-persistence trap, and inspection cannot prove it.

- [ ] **Step 5: Commit** — `feat(docker): run the whole stack with docker compose`

---

### Task 4: A Docker-first README that someone has followed

**Files:**
- Modify: `README.md`, `docs/pending.md`

- [ ] **Step 1: Restructure, do not rewrite**

Docker becomes the primary path. **Keep the from-source path** — it is what `npm run check`, the Playwright suites and every contributor use, and the existing README was verified by a literal clean-shell follow. Do not regress its content; move it under a clearly-named section.

The Docker path must state:
- generate the master key **once**, and what breaks if it is regenerated;
- account creation is `docker compose exec …` **and why it is not a web form** (no HTTP route may create a user);
- the API key now goes in **the browser form**, not curl.

Keep the existing "What to expect" (≈$1.74, ≈11 minutes, no cancellation, `interrupted` means unknown and is routine, a section can ship as a placeholder box) and **add the accepted risk**: on Gemini, spend shows as a floor because those models have no published rates here, so the cap does not bound it.

- [ ] **Step 2: Follow the Docker path literally, from a clean state**

`docker compose down -v` first, so volumes are genuinely empty. Every command must work **as written**. A step needing knowledge that is not in the README is a **README bug — fix the README**. Report every correction; that list is the deliverable.

- [ ] **Step 3: Close B-items and record what is left** in `docs/pending.md`.

- [ ] **Step 4: Commit** — `docs: make the README Docker-first`

---

## What this plan does not do

- **No Gemini rates in `pricing.py`.** Accepted deliberately; the mitigation is surfacing `unpricedEvents`. Tracked in `docs/pending.md`.
- **No production hosting, no cross-origin preview, no per-user isolation.** Properties of a shared hosted instance, which this deployment model does not create.
- **No live generation.** No task here spends model money; the pipeline is proven live by round 1.
- **Nothing from P1-across-processes, H1–H6, H2, F17–F19, U1, R-1…R-6.**
