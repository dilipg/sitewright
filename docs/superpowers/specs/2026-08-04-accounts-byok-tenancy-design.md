# Accounts, BYOK and tenancy — design

**Date:** 2026-08-04
**Status:** approved, ready for implementation planning
**Slices:** 2, 3 and 4 of the five in
`docs/superpowers/specs/2026-08-03-prompt-driven-editing-design.md`. Slice 1
(prompt-driven editing) is merged. Slice 5 (web-triggered generation) is out.

One document for three slices because they share a threat model, a data store
and a request path. The plan that follows it **ships slice 2 alone first**:
getting sessions wrong is far cheaper to discover before key storage depends on
them.

## The problem, stated plainly

This product's core loop **executes code**. Export runs the generated project's
own `tsc` and `vite build`; regeneration spawns `uv run python`; the preview is
a live Vite dev server over model-generated source. Slice 3 asks us to store
users' Anthropic API keys on that same host.

Arbitrary code execution plus other people's bearer credentials on one box is
what makes this a security project rather than a feature. Every decision below
is downstream of that sentence.

## Threat model — read this before anything else

**Invite-only. There is no self-registration, and a hostile user is out of
scope.** Accounts are created by an operator on the box; a bad actor is handled
by revoking access, not by the software.

This must be **structural, not merely unimplemented**: the login page carries no
sign-up link, and no HTTP route creates a user. If a future reader wonders
whether public signup was forgotten or excluded, this paragraph is the answer —
it was excluded, and the *Not in this design* section lists what public signup
would have to add.

## Scope

**In:** password login with server-side sessions; user-supplied Anthropic API
keys stored encrypted; per-user ownership of projects with authorization on
every HTTP endpoint; a per-user spend cap; a preview-server pool so more than
one project can be open at once; an operator CLI for user lifecycle.

**Out:** self-registration, password reset by email, roles or an admin UI,
project sharing, sandboxing of generated code, a job model for long-running
work, cross-origin preview isolation, and web-triggered generation (slice 5).

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Invite-only, no self-registration | Public or gated signup | Defers sandboxing and *only* sandboxing. Accounts, key storage and per-user data isolation are all required under public signup too, so none of this work is throwaway. |
| 2 | One VM with a persistent disk, single Node process | Ephemeral-container PaaS | Everything here is filesystem-shaped. `prepare_workspace_dir` mutates a copied tree across processes; export shells out to `tsc`/`vite build` needing a real working directory with `node_modules`; regen's revert copies a `.regen-backup` beside the project. None survives an ephemeral filesystem without redesigning the compiler and orchestrator. |
| 3 | One Vite dev server per open project, spawned on demand, proxied, reaped, **capped at 6** | Build each project to static and serve files | Static guts the product: the shim applies overrides to a *running* DOM over `postMessage`, regeneration expects HMR-fresh modules, and the invariant suite's premise loses its "preview" half. Cost is real ops surface, accepted. |
| 4 | SQLite, holding **identity only** | JSON files; Postgres | Not scale — concurrency. The existing file-per-thing pattern is safe *because the contract gives each file exactly one writer*; a user table breaks that. This codebase has already been bitten twice by that class of bug (5.4's lost first edit; the manifest service's cross-process lock). Postgres adds a service to run and back up for no benefit at this size. |
| 5 | Same-origin preview (`/preview/<projectId>/*`) **for now** | Separate origin per project | Chosen for speed, with a named accepted risk and a documented migration (below). |
| 6 | Server master key, AES-256-GCM | Key derived from the user's password | Password-derived is stronger but breaks this product: fan-out spawns workers for minutes, work outlives requests, resumed Kitaru executions cannot re-authenticate, and a password reset would destroy the key irrecoverably. Those are the normal path here, not edge cases. |
| 7 | Auth at the HTTP boundary only; hosted server is a **separate composition root** | Tests authenticate; or a bypass token | Making 99 e2e tests depend on the auth stack couples the invariant suite — the enforcement mechanism for preview = handover — to the newest, least-settled subsystem. A bypass token is a production code path that exists to be disabled. |
| 8 | A project **is** a run directory; one owner | A project containing many runs | Nothing in the system creates a second run for a project — regen, add-section and the edit agent all mutate in place. Modelling one-to-many would build joins and a "current run" pointer for a cardinality that is always one. |
| 9 | Spend cap: **$10 per rolling 24h**, per user, overridable | No cap; per-run cap | The accounting already exists (`record_usage`, `pricing.py`); what is missing is a user dimension and a check. A per-run cap requires predicting retries, and retries are where runaway risk lives. |
| 10 | Users created by operator CLI, password generated | Admin UI; emailed invite links | An admin UI means a role system and a first-admin bootstrap to avoid a terminal already used for deploys. Email means a vendor, bounce handling and a token lifecycle to send five links. |
| 11 | Long operations stay synchronous; generous proxy timeout | Job model now | A job model is slice 5's work (561s generation). Retrofitting regen, page regen, add-section, export and edit-prompt into an async shape before shipping a login screen blocks accounts on slice 5. |
| 12 | Sessions: server-side rows + cookie | JWT | Revocation is the point — invite-only means removing someone takes effect immediately. A stateless token cannot be withdrawn. |
| 13 | **Work in flight survives disconnect** — it continues server-side; the UI reconnects and reads current state | Cancel a user's runs when their session ends | This falls out of decision 6: the server master key was chosen *precisely* so work does not die with a session. Killing a fan-out halfway leaves a half-generated project, which is worse than an orphaned run. |

## Architecture

Two composition roots over **the same handlers**. This is the load-bearing idea:
authorization is added by composition, not by editing the handlers.

```
LOCAL (unchanged, unauthenticated)          HOSTED (new)
compiler/scripts/preview.ts                 server/ (new package)
  └ Vite dev server                           ├ session middleware
    └ regenApiPlugin, exportApiPlugin         ├ tenancy middleware (deny by default)
                                              ├ spend-cap middleware
                                              ├ serves the editor build
                                              ├ /api/*  (auth, keys, projects)
                                              └ /preview/<projectId>/*  ─┐
                                                                         │ reverse proxy
                                              preview pool ──────────────┘
                                                └ one Vite dev server per open project
                                                  (dynamic port, reaped, max 6)
```

`preview.ts` and the 636 existing tests keep working exactly as they do now.

### Deny by default

The hosted server mounts an allowlist. A route is **inaccessible until
explicitly registered** with its authorization rule. This is a structural
requirement, not a convention: this codebase added four endpoints in the last
two slices, and middleware that must be remembered will eventually be forgotten.

Every project-scoped endpoint resolves `projectId`, loads one row, and compares
`ownerId` to the session user. One rule, one place:

`/__overrides/<slug>` (PUT) · `/__overrides-history` · `/__regen` ·
`/__regen-page` · `/__regen-revert` · `/__add-section` · `/__edit-prompt` ·
`/__export` · `/__export-download` · `/__plan`

`/__archetypes` is project-independent and needs only a session.

## Data model (SQLite)

Identity only. **Generated projects stay on the filesystem**; the DB records
who owns which directory, never its contents.

```sql
user            id, email UNIQUE, password_hash, spend_cap_usd, created_at, disabled_at
session         id, user_id, expires_at, created_at            -- deletable = revocable
api_key         user_id PK, ciphertext, nonce, fingerprint, created_at
project         id, owner_id, directory, name, created_at
usage_event     id, user_id, project_id NULL, role, model, tokens…, cost_usd, at
```

`usage_event` is the existing `record_usage` data plus a `user_id`. It is the
spend cap's source of truth and fixes a known gap: `cost_for_run` currently
cannot see edit-agent spend, because the agent writes the global usage log while
that function reads the per-run one — so today's cost reporting already
understates reality, and would understate a user's bill.

## Authentication

- **argon2id** for passwords. Not bcrypt: its 72-byte truncation is a real
  footgun.
- **Server-side sessions**: a row in SQLite, referenced by an `httpOnly`,
  `SameSite=Lax`, `Secure` cookie. `Lax` rather than `Strict` so preview iframe
  navigation works.
- Deleting the session row logs the user out **immediately**, everywhere.

### Operator CLI

`user:create`, `user:disable`, `user:reset-password`, `user:set-cap`.

`user:create` **generates** the initial password and prints it once — it is
never accepted as an argument, so it does not land in shell history. Only the
argon2id hash is stored.

## BYOK

The key is a bearer credential for someone else's account. If it leaks it is
their money and their data.

1. **The master key lives only in an env var or systemd credential** — never in
   the repo, the DB, or a committed `.env`. **The app refuses to boot without
   it** rather than falling back to a default.
2. **The key is never logged.** This codebase writes `usage.jsonl` and run logs
   liberally; redaction happens at the boundary where the key is read.
3. **Only a fingerprint** (last 4 characters) is ever returned to the UI, so a
   hijacked session cannot harvest the key.
4. **Storing it is optional.** Paste-per-session must remain possible; the row
   is a convenience.
5. The orchestrator currently reads `ANTHROPIC_API_KEY` from `orchestrator/.env`.
   Under the hosted server the key is injected into the subprocess environment
   per invocation, for that user's request only.

## Spend cap

- Default **$10 per rolling 24 hours**, per user, overridable per user.
- Computed from `usage_event` over the trailing 24h.
- **Gates starting work only.** Never interrupts a run: killing a fan-out
  halfway leaves a half-generated project, which is worse than the overspend.
- The error **states the cap, the spend and the reset time.** "Insufficient
  budget" with no numbers produces a support conversation instead of an obvious
  action.

## Preview pool

- One Vite dev server per **open** project, spawned on demand on a dynamic port.
- The hosted server reverse-proxies `/preview/<projectId>/*` to it, after the
  ownership check.
- Idle servers reaped after a configurable timeout.
- **Hard cap of 6 concurrent**, with a clear error when reached. Unbounded means
  five users opening three projects each is fifteen Vite servers and an OOM.

## Operational requirements

- **Proxy timeout set above the slowest measured operation, with margin.** Not
  left at a default. Measured: section regen ~90s, add-section ~84s, page regen
  ~5 min, export with build several minutes. The failure mode is not an error —
  **a 504 does not stop the subprocess**, so work completes, the UI shows
  failure, the user retries, and two page regens mutate the same directory.
- **Work in flight is not tied to a session.** A regen or export that outlives
  the browser tab completes; the UI reads current state on reconnect rather than
  assuming its own request's outcome. This is why the master key is server-held
  (decision 6) — a session-derived key would kill exactly this case.
- **A named owner for disk retention.** Nothing currently deletes generated
  projects and each acceptance run is hundreds of MB.
- Existing `generated/` directories are **adopted on first boot** and assigned
  to a bootstrap user, rather than orphaned — there are real acceptance runs
  worth keeping.

## Accepted risks — written down, not discovered later

1. **Same-origin preview removes an unintentional sandbox.** Today's iframes are
   cross-origin, which prevents generated code touching the editor's DOM or
   making same-site authenticated requests. Same-origin removes that, and the
   code inside is **model-generated from a free-text brief** — untrusted input.
   A prompt injection could plausibly produce a snippet that exfiltrates the
   stored key using the user's own session.
2. **Root on the VM holds both ciphertext and master key.** Inherent to
   server-side decryption; what a password-derived key would have fixed.
3. **Preview processes run as the same OS user** and can read each other's
   directories. Accepted under invite-only.
4. **The authorization layer has no coverage from the existing 636 tests**,
   because they deliberately never traverse it (decision 7). Slice 4 owes its
   own tests.

### Migrating risk 1 to cross-origin later

1. Wildcard DNS for `*.preview.<domain>`.
2. A wildcard TLS certificate.
3. Session cookie scoped to the preview domain, **or** a short-lived signed
   token in the proxy path.
4. **Tighten the shim's `postMessage` target origin from `"*"` to the exact
   preview origin** — harmless same-origin, wrong cross-origin. Same for the
   parent's calls into each frame.
5. Re-check the frame-ready and geometry protocol against a real cross-origin
   boundary. The invariant suite already documents cross-origin iframes
   silently swallowing wheel events; expect similar surprises.

## Testing

- **The existing 636 tests must stay green and unauthenticated.** They exercise
  `preview.ts`, not the hosted root.
- **New: authorization tests against the hosted composition** — a request for
  another user's project is rejected on *every* project-scoped endpoint. Table-
  driven over the endpoint list, so adding an endpoint without a rule fails.
- **New: session lifecycle** — login, logout, expiry, and that deleting a
  session row revokes access immediately.
- **New: key handling** — round-trip encrypt/decrypt; the plaintext key never
  appears in any log sink; only a fingerprint is returned by the API.
- **New: spend cap** — work is refused past the cap, permitted under it, the
  window rolls, and the error carries cap/spend/reset.
- **New: preview pool** — spawn, reuse for a second request, reap on idle, and a
  clear error at the cap.

## Shipping order

**Slice 2 first, alone.** Accounts with no keys and no tenancy is independently
testable and deployable. Sessions are the foundation both other slices build on,
and a session bug found after key storage depends on it is far more expensive.

Then **slice 3** (BYOK), then **slice 4** (tenancy, preview pool, spend cap).

## Not in this design

Self-registration · password reset by email · roles or an admin UI · project
sharing · sandboxing of generated code · a job model for long-running work ·
cross-origin preview · web-triggered generation.

**What public signup would additionally require**, so the gap is explicit:
per-user sandboxing of builds and generated code, resource limits, network
egress control, a build worker separate from the API host, email-based account
recovery, rate limiting beyond the spend cap, and abuse reporting.
