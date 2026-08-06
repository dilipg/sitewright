# Mounting the Compiler Endpoints (slice 4c-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the twelve `/__*` compiler endpoints on the hosted server — each behind the ownership check, the four billable ones behind the spend cap — and attribute every model call they make to the user who paid for it.

**Architecture:** The endpoints are not reimplemented. They already exist as Vite plugin middleware inside each project's preview child (`compiler/src/regen-api.ts`, `plan-api.ts`, `export-api.ts`), which 4c-1 made reachable. The hosted server registers each path in its route table, authorizes it, and proxies `req.url` verbatim to that project's child. Spend attribution rides a server-generated opaque id: the child writes the orchestrator's usage log to a path derived from it, and the server ingests exactly that file once the response is done.

**Tech Stack:** Node 24, TypeScript, vitest; the orchestrator is invoked by the child, not by the server.

## Context

Slice 4c-1 is merged: `PreviewPool` (one child per project, probed port, reaped, capped at 6), `proxyHttp`/`proxyUpgrade`, `GET /preview/:projectId/*` behind `requireProject`, and the upgrade handler. **This plan is the second and final half of 4c.**

Read before starting:
- `docs/superpowers/specs/2026-08-04-accounts-byok-tenancy-design.md` — "Deny by default" (the endpoint list), "Spend cap", "Operational requirements", "Accepted risks".
- `docs/decisions.md` — the 2026-08-05 rows for 4b and 4c-1. Several are directly binding here.
- `CLAUDE.md` — the ownership map and the two `server/` rules.

**Three facts established by earlier slices that this plan depends on.**

1. **Forward `req.url` verbatim.** 4c-1 proved that stripping a prefix makes Vite redirect back to it and loop the client. Here the paths are already top-level (`/__regen?project=X`), and the child's middleware matches on `req.url.split("?")[0]`, so verbatim forwarding gives it exactly `/__regen`. Do not "normalise" anything.
2. **A plugin's `configureServer` middleware registers before Vite's own base middleware**, so it sees the un-stripped URL. That is *why* forwarding `/__regen` unprefixed works, and why forwarding `/preview/<id>/__regen` would not.
3. **`ingestUsageLog` is deliberately not idempotent.** Ingest exactly once, from a path unique to the invocation, then delete the file. The safe-looking retry is the one that doubles a bill.

## Global Constraints

1. **Auth lives at the HTTP boundary only.** `compiler/scripts/preview.ts` stays unauthenticated and locally usable; `npm run check` never needs a login. Changes to `compiler/` here are additive and inert when the new header is absent.
2. **Deny by default.** The route table IS the allowlist. Every endpoint appears in exactly one `project-registry.ts` list with a `billable` flag; `project-registry.test.ts` enforces that the lists are a partition of the live table, and it has a tripwire asserting no billable endpoint is mounted — **that tripwire will fire in this slice, and it must be replaced with a real enforcement test, not deleted.**
3. **No HTTP route may create a user.**
4. **The spend cap gates starting work only.** Never interrupt a run.
5. **Under-counting spend is the dangerous direction.** A lost usage log means the user is billed less than they cost.
6. **No client-controlled filesystem paths.** The usage-log location is derived from a server-generated opaque id, validated at both ends. Any inbound copy of the header carrying it must be stripped before forwarding, or a client gains a write primitive.
7. **Nothing may log an API key or the master key.** `redactSecrets` is wired for child output; keep it that way.
8. **A process with work in flight is never reaped**, and the cap of 6 must not leak down. Every proxied request is bracketed `retain`/`release` with `release` in a `finally`.
9. No new runtime dependencies. Migrations append-only. No platform-specific path literals in assertions (CI is ubuntu).
10. **Every test must fail if the behaviour it names is removed.** Perturb, watch the named assertion fail, restore. If a perturbation does not fail, say so rather than moving on — that has changed the design three times across these slices.
11. **Never modify `docs/` to make code pass.**

---

### Task 1: A per-invocation usage log the child writes and the server reads

**Files:**
- Modify: `compiler/src/regen-api.ts` (`runProcess` gains an env argument; the four billable handlers pass a usage-log path derived from a request header)
- Create: `compiler/src/usage-log-path.ts`
- Test: `compiler/src/usage-log-path.test.ts`, and extend `compiler/src/regen-api.test.ts`

**Interfaces:**
- Produces:
  - `USAGE_ID_HEADER = "x-webgen-usage-id"`
  - `isValidUsageId(value: unknown): value is string` — exactly 32 lowercase hex characters.
  - `usageLogPathFor(usageId: string): string` — `join(tmpdir(), "webgen-usage", `${usageId}.jsonl`)`.
  - `runProcess(command, args, cwd, env?)` — an added optional 4th parameter, merged over `process.env`.

**Why an opaque id rather than a path.** The server could send the log path directly, but that header is client-settable: on the local unauthenticated preview a caller would choose where a subprocess writes, and on the hosted server it would only be safe as long as nobody forgot to strip the inbound copy. An id that must match `^[0-9a-f]{32}$`, with both sides computing the path from it, makes the traversal impossible rather than merely guarded. It also keeps the log out of the project directory, so nothing has to be excluded from the exporter or the preview's file watcher.

- [ ] **Step 1: Write the failing tests**

`compiler/src/usage-log-path.test.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidUsageId, usageLogPathFor, USAGE_ID_HEADER } from "./usage-log-path.ts";

describe("isValidUsageId", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isValidUsageId("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects anything that could name a path", () => {
    // The whole point: an id can never be a path, so a subprocess's log
    // location is not client-controlled.
    for (const bad of [
      "../../etc/passwd", "0123456789abcdef0123456789abcde", "0123456789ABCDEF0123456789abcdef",
      "0123456789abcdef0123456789abcdef0", "", "abc/def", "abc\\def", 42, null, undefined,
    ]) {
      expect(isValidUsageId(bad)).toBe(false);
    }
  });
});

describe("usageLogPathFor", () => {
  it("puts the log in a temp subdirectory named by the id", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(usageLogPathFor(id)).toBe(join(tmpdir(), "webgen-usage", `${id}.jsonl`));
  });

  it("names the header both sides agree on", () => {
    expect(USAGE_ID_HEADER).toBe("x-webgen-usage-id");
  });
});
```

Then extend `compiler/src/regen-api.test.ts` (read it first — it documents itself as covering "the one thing about the regen endpoints that is testable without a model"). Add cases asserting that `runProcess`'s env argument reaches the child: the cleanest way is a test that spawns `node -e` printing `process.env.WEBGEN_USAGE_LOG` and asserts the value, following that file's existing argv-preservation test as the pattern.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w compiler -- usage-log-path`
Expected: module not found.

- [ ] **Step 3: Implement**

`compiler/src/usage-log-path.ts`:

```ts
// compiler/src/usage-log-path.ts
/**
 * Where a regeneration's token-usage log goes, and the request header that
 * selects it.
 *
 * The hosted server needs one usage log per billable request so it can
 * attribute that request's spend to one user (server/src/ingest-usage.ts).
 * The orchestrator already honours WEBGEN_USAGE_LOG; what was missing is a
 * way for a per-request value to reach it, since a preview child is
 * long-lived and its environment is fixed at spawn.
 *
 * An opaque id, never a path. A header naming a path would let whoever sets
 * it choose where a subprocess writes — on the local unauthenticated preview
 * that is the caller, and on the hosted server it would be safe only for as
 * long as nobody forgot to strip the inbound copy before proxying. An id
 * constrained to 32 hex characters cannot name a path at all, and both sides
 * derive the same location from it.
 *
 * The temp directory rather than the project's own: a file inside the project
 * would have to be excluded from the exporter's copy and from the preview
 * server's file watcher, and forgetting either is a silent bug.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const USAGE_ID_HEADER = "x-webgen-usage-id";

const USAGE_ID = /^[0-9a-f]{32}$/;

export function isValidUsageId(value: unknown): value is string {
  return typeof value === "string" && USAGE_ID.test(value);
}

export function usageLogPathFor(usageId: string): string {
  if (!isValidUsageId(usageId)) throw new Error("invalid usage id");
  return join(tmpdir(), "webgen-usage", `${usageId}.jsonl`);
}
```

In `compiler/src/regen-api.ts`:

- give `runProcess` an optional 4th parameter and spawn with a merged env:

```ts
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Merged over the inherited environment rather than replacing it: the
    // orchestrator needs PATH, and under the hosted server it needs the
    // ANTHROPIC_API_KEY the preview pool put in this process's environment
    // for its owner. Only the caller's additions are new.
    const env = extraEnv === undefined ? undefined : { ...process.env, ...extraEnv };
    const child = spawn(command, args, env === undefined ? { cwd } : { cwd, env });
```

- add a helper that turns a request into the env addition, and thread it through the four handlers that spawn the orchestrator (`/__regen`, `/__regen-page`, `/__add-section`, `/__edit-prompt`):

```ts
/**
 * The env addition for a request that may spend money. Absent header → no
 * addition, so the local unauthenticated preview behaves exactly as before
 * and keeps writing to the orchestrator's own shared runlog.
 */
function usageEnvFor(req: IncomingMessage): NodeJS.ProcessEnv | undefined {
  const raw = req.headers[USAGE_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidUsageId(value)) return undefined;
  const path = usageLogPathFor(value);
  mkdirSync(dirname(path), { recursive: true });
  return { WEBGEN_USAGE_LOG: path };
}
```

An invalid header is ignored rather than rejected: a malformed id is not the child's problem to police, and refusing the whole request would turn a server-side bug into a user-visible failure of work that would otherwise succeed. The server-side test in Task 3 is what proves the id is well-formed in practice.

- [ ] **Step 4: Run the tests, then the whole compiler suite**

Run: `npm test -w compiler`
Expected: PASS, 192 pre-existing plus the new cases. Then `npm run test:e2e -w compiler` (13) — it drives these endpoints in mock mode.

- [ ] **Step 5: Prove the header is load-bearing**

Temporarily make `usageEnvFor` always return `undefined`. Confirm the test asserting `WEBGEN_USAGE_LOG` reaches the child FAILS. Restore. Report the failure verbatim.

- [ ] **Step 6: Commit**

```bash
git add compiler/src/usage-log-path.ts compiler/src/usage-log-path.test.ts compiler/src/regen-api.ts compiler/src/regen-api.test.ts
git commit -m "feat(compiler): let a request select a per-invocation usage log"
```

---

### Task 2: Mount the twelve endpoints

**Files:**
- Create: `server/src/compiler-routes.ts`
- Test: `server/src/compiler-routes.test.ts`
- Modify: `server/src/compose.ts`, `server/src/compose.test.ts`
- Modify: `server/src/project-registry.ts` and `server/src/project-registry.test.ts` (the tripwire fires here)
- Modify: `server/src/preview-proxy.ts` (strip the inbound usage-id header)

**Interfaces:**
- Consumes: `PreviewPool`, `PreviewCapacityError`; `proxyHttp`; `requireProject`; `requireBudget`; `PROJECT_SCOPED_ENDPOINTS`.
- Produces: `compilerRoutes(deps: { db, pool }): Route[]`.

**The endpoints, and how each is wrapped.** Derive the list from `PROJECT_SCOPED_ENDPOINTS`' `/__*` entries rather than retyping it — a second hand-written list is exactly the drift the registry exists to prevent. Wrap `requireProject`, and additionally `requireBudget` when the registry entry says `billable`.

`GET /__archetypes` is the exception and needs a decision recorded. The registry lists it session-only and project-independent, but it is served by `regenApiPlugin`, which only exists inside a project's child. **Resolve it by requiring a project after all**: change its registry entry to project-scoped with `idFrom: BY_QUERY`, and say why in a `docs/decisions.md` row — the alternative (picking an arbitrary running child, or giving the server its own copy of the archetype catalog) either depends on unrelated state or duplicates data the compiler owns. If you disagree after reading the code, stop and report rather than choosing silently: this is a spec deviation, and the spec says `/__archetypes` "needs only a session."

- [ ] **Step 1: Write the failing tests**

`server/src/compiler-routes.test.ts`, driving the real route table through `createRequestListener` with a fake pool and a stubbed `proxyHttp` (follow `preview-routes.test.ts`, which already does exactly this). Cover:

1. Every `/__*` entry in the registry is present in `compilerRoutes`' output, and every route it produces is in the registry — a bidirectional check, so neither list can drift.
2. An unauthenticated request to each gets 401 and **the pool is never touched**.
3. A request naming another user's project gets 404, and the pool is never touched.
4. The owner's request proxies, with `req.url` — query string included — arriving verbatim.
5. **A billable endpoint over the spend cap answers 402 and never touches the pool.** This is the enforcement test the 4b tripwire exists to force; assert the body carries `capUsd`, `spentUsd` and `resetAt`.
6. A non-billable endpoint (`/__export`) is NOT gated: it succeeds for a user who is over the cap. Exporting spends nothing, and refusing it would strand a user's work behind a bill.
7. `release` is called even when the proxy rejects.
8. A client-supplied `x-webgen-usage-id` header does not reach the upstream (see Task 3 for where the server's own is set).

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement `server/src/compiler-routes.ts`**

One factory reading the registry:

```ts
// server/src/compiler-routes.ts
/**
 * The twelve compiler endpoints, mounted.
 *
 * They are NOT reimplemented here. Each already exists as Vite plugin
 * middleware inside the project's own preview child (compiler/src/
 * regen-api.ts, plan-api.ts, export-api.ts) — the spec's "two composition
 * roots over the same handlers". This module adds authorization by
 * composition and forwards bytes.
 *
 * The path forwarded is `req.url` VERBATIM. Two reasons, and both were
 * learned the hard way in 4c-1: Vite redirects a stripped path back to the
 * prefix just removed (looping the client), and a plugin's configureServer
 * middleware registers BEFORE Vite's own base middleware, so it matches on
 * the un-stripped URL — which is exactly why `/__regen` works unprefixed and
 * `/preview/<id>/__regen` would not.
 *
 * The endpoint list is DERIVED from project-registry.ts rather than retyped.
 * A second hand-written list is the drift the registry exists to prevent, and
 * a route mounted here without a registry entry fails
 * project-registry.test.ts's partition check.
 */
```

Build each route by looking up its registry entry, composing `requireProject(db, entry.idFrom, inner)` and, when `entry.billable`, wrapping `inner` in `requireBudget(db, …)`. The inner handler acquires, retains, proxies `req.url`, releases in a `finally`, and maps `PreviewCapacityError` to 503 exactly as `preview-routes.ts` does — extract that shared handler rather than duplicating it if the shapes match.

In `server/src/preview-proxy.ts`, add `USAGE_ID_HEADER` to the headers `upstreamHeaders` deletes, alongside `cookie` and `authorization`. Task 3 re-adds the server's own value deliberately; what must never happen is a client's value surviving.

- [ ] **Step 4: Replace the 4b tripwire with a real enforcement test**

`project-registry.test.ts`'s placeholder asserts no billable endpoint is mounted. It will now fail — **that is the tripwire working.** Replace it with the test it was protecting: for every registry entry marked `billable`, drive a real over-cap request through the live route table and assert 402. Table-driven over the registry, so a billable endpoint added later without a gate fails. Delete the placeholder and its comment.

- [ ] **Step 5: Prove two things load-bearing**

1. Remove `requireBudget` from the composition. Expected: the over-cap 402 tests FAIL for every billable endpoint.
2. Remove the `USAGE_ID_HEADER` deletion from `upstreamHeaders`. Expected: the client-supplied-header test FAILS.

Report both verbatim.

- [ ] **Step 6: Run everything and commit**

Run `npm test -w server`, then `npm run check`.

```bash
git commit -m "feat(server): mount the compiler endpoints behind ownership and the spend cap"
```

---

### Task 3: Attribute the spend

**Files:**
- Modify: `server/src/compiler-routes.ts`
- Test: `server/src/compiler-routes.test.ts`
- Modify: `server/src/preview-proxy.ts` (allow the server to set a header on the forwarded request)

**Interfaces:**
- Consumes: `ingestUsageLog` from `./ingest-usage.ts`; `USAGE_ID_HEADER`, `usageLogPathFor` from `compiler/src/usage-log-path.ts` — a cross-package import; if `server/` cannot import from `compiler/` cleanly, duplicate the two constants with a comment naming the other copy and a test asserting they agree, and report which you did.

**The flow.** For a billable request the server generates 16 random bytes as hex, sets `x-webgen-usage-id` on the forwarded request, and after the proxy resolves — in the same `finally` as `release` — ingests `usageLogPathFor(id)` exactly once and deletes the file.

Three details are load-bearing:
- **Ingest after the response, not before.** The orchestrator writes as it goes and the child only returns when the run is done.
- **Ingest exactly once, then delete.** `ingestUsageLog` is not idempotent; a retry doubles the bill.
- **Ingest even when the request failed.** A run that errored halfway still spent money. This is why it belongs in the `finally`, and why `ingestUsageLog` was built never to throw.

- [ ] **Step 1: Write the failing tests**

1. A billable request forwards a well-formed `x-webgen-usage-id` (assert against `^[0-9a-f]{32}$`), and a different one per request.
2. A non-billable request sends no such header — nothing to ingest, so nothing to generate.
3. After a billable request whose child wrote a usage log, `usage_event` holds the rows and `spendSince` reflects the cost. Simulate by having the stubbed proxy write a two-row log at the path the id implies.
4. The log file is **deleted** after ingest.
5. A billable request whose child wrote **no** log ingests nothing and does not throw.
6. A billable request whose proxy **rejected** still ingests. This is the one that matters most: spend survives failure.
7. Ingest happens exactly once — assert one set of rows, not two, after a single request.

- [ ] **Step 2-4: implement, run, and prove**

Extend `proxyHttp`'s args with an optional `setHeaders?: Record<string, string>` applied after `upstreamHeaders` (so the server's value wins over a stripped client one), implement the generate/ingest/delete flow in the billable branch, and prove load-bearing: remove the `finally`'s ingest call and confirm test 3 fails; remove the delete and confirm test 4 fails; make the id constant and confirm test 1's uniqueness assertion fails.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(server): attribute each billable request's model spend to its owner"
```

---

### Task 4: Map the typed errors, and bound concurrent starts

**Files:**
- Modify: `server/src/compiler-routes.ts`, `server/src/preview-pool.ts`
- Test: their test files

**Two gaps recorded in `docs/decisions.md` as open, both closed here.**

**The errors.** Nothing maps `MissingApiKeyError`, `UndecryptableApiKeyError` or `DisabledUserError` to a status. A billable request from a user with no stored key currently reaches the child, which spawns the orchestrator, which fails on a missing key deep inside a subprocess — a 500 for what is a clear, actionable user error. Map them at the boundary:
- `MissingApiKeyError` → **400** with a message telling the user to add a key. It is a precondition the user can fix.
- `UndecryptableApiKeyError` → **500**, and log it: the ciphertext no longer opens under the current master key, which is an operator problem, not a user one. Note that `getApiKeyFingerprint` still reports a healthy fingerprint for such a row, so the UI will show a key that cannot be used — record that in the decision row.
- `DisabledUserError` → **403**. Distinct from 401: the session was valid.

Only billable endpoints need a key, so check where the key is actually required rather than refusing a preview or an export.

**The concurrent-start bound.** Spend lands in `usage_event` only at ingest, so N concurrent billable requests all evaluate the cap against the same pre-run total. The spec accepts overshoot for one run but never bounds the multiplier. Bound it with an in-flight reservation: the pool already knows how many children are busy, so add a per-user count of in-flight billable requests and refuse beyond a small limit (2) with 429 — **429 is right here, unlike the cap's 402, because retrying genuinely will help once the in-flight run finishes.** Test that the second concurrent request is allowed, the third refused, and that the count drops when a request completes, including when it fails.

- [ ] Steps: tests first, implement, prove each mapping load-bearing by perturbation, run `npm run check`, commit.

---

### Task 5: Verify against a real child

Unit tests all stub the proxy, so nothing so far proves a real regeneration works through the hosted server. Do this by hand and paste results into the report.

Use `WG_REGEN_MOCK=1` so no model is called and no money is spent — mock mode mirrors the real contract, which is what the editor's own e2e relies on.

1. Create a user, store a dummy API key, start the server against a real project.
2. `POST /__regen?project=<id>` with a section id and instruction; confirm 200 and a `REGEN_RESULT` payload.
3. Confirm `GET /__plan?project=<id>` and `GET /__archetypes?project=<id>` return their payloads.
4. Confirm `POST /__export?project=<id>` runs the exporter and `GET /__export-download` returns a zip.
5. Set the user's cap to 0 with the CLI, retry `POST /__regen`, and confirm **402** with cap/spend/reset in the body — then confirm `POST /__export` still succeeds.
6. Confirm another user gets 404 on every one of the twelve.
7. Report whether any `usage_event` rows landed. In mock mode there is no model call, so **zero rows is the correct answer** — say so explicitly rather than reporting it as a failure. If you can afford one real (non-mock) regen, do it and report the ingested rows and cost; if not, say that the ingest path is proven only by unit tests.

Then: `npm run check`, commit, and write the report.

---

## What this slice deliberately does not do

1. **Slice 5 (web-triggered generation) is still out.** No route creates a project; generation needs a job model, since a run outlives its request.
2. **`/__archetypes` deviates from the spec** by requiring a project. Recorded in `docs/decisions.md`, flagged for a human.
3. **`Nav.tsx`'s raw `<a href>`** still escapes the preview on a nav click. Out of scope, recorded in 4c-1.
4. **The reservation bounds concurrent starts, not total overshoot.** A single run can still exceed the cap; the spec accepts that explicitly.
