# Slices 2–4 (accounts, BYOK, tenancy) — decisions so far

**Status: SUPERSEDED** by `2026-08-04-accounts-byok-tenancy-design.md`, which
carries every decision here plus the ones settled afterwards. Kept only as the
record of how the decisions were reached; the design doc is authoritative.

Covers slices 2, 3 and 4 of
`docs/superpowers/specs/2026-08-03-prompt-driven-editing-design.md`'s
decomposition: accounts, BYOK secrets, tenancy & isolation. Slice 1
(prompt-driven editing) is merged.

## The problem in one paragraph

This product's core loop **executes code**: export runs the generated project's
own `tsc` and `vite build`; regeneration spawns `uv run python`. Slice 3 then
asks us to store users' Anthropic API keys on that same host. Arbitrary code
execution plus other people's secrets on one box is what turns "add login" into
a security project rather than a feature.

## Starting facts (verified in the repo, not assumed)

- No hosting config of any kind — only a CI workflow. No Dockerfile.
- **Zero** auth/DB/session dependencies in any `package.json`.
- The preview server is a Vite dev server bound to **one** project directory,
  launched from a CLI with a fixed port. It has no concept of a second project.
- **11 endpoints** would need authorization: `/__overrides/<slug>` (PUT),
  `/__overrides-history`, `/__regen`, `/__regen-page`, `/__regen-revert`,
  `/__add-section`, `/__edit-prompt`, `/__export`, `/__export-download`,
  `/__archetypes`, `/__plan`. None has any today.

## Decisions settled

| # | Decision | Chosen | Why, and what it costs |
|---|---|---|---|
| 1 | Threat model | **Invite-only, small trusted group.** No self-registration. | Defers sandboxing, and *only* sandboxing — accounts, key storage and per-user data isolation are all needed under public signup anyway, so none of the work is throwaway. Must be stated bluntly in the spec, and the login page must carry no sign-up link: the absence of self-registration should be structural, not merely unimplemented. |
| 2 | Deployment target | **One VM with a persistent disk**, single Node process. | Everything here is filesystem-shaped. Three things would each need reworking on an ephemeral filesystem: `prepare_workspace_dir` mutates a copied tree across processes; export shells out to `tsc`/`vite build` needing a real working dir with `node_modules`; regen's revert copies a `.regen-backup` beside the project. **Open obligation:** name a disk-retention owner — nothing currently deletes generated projects, and each acceptance run is hundreds of MB. |
| 3 | Preview under multi-user | **One Vite dev server per open project, spawned on demand**, dynamic port, main server reverse-proxies, idle ones reaped. | The alternative (build to static) guts the product: the shim applies overrides to a *running* DOM over `postMessage`, regen expects HMR-fresh modules, and the invariant suite's premise loses its "preview" half. Cost is real ops surface: N Node processes, port allocation, lifecycle, reaping. **Spec must include** a hard cap on concurrent preview servers with a clear error when hit, and must record that preview processes run as the same OS user and can read each other's directories — an accepted risk that public signup would have to fix. |
| 4 | State store | **SQLite** (one file on the VM disk). | Not about scale — about concurrency. The existing file-per-thing pattern is safe *because the contract gives each file exactly one writer*; a user table breaks that. This codebase has already been bitten by that class of bug twice (5.4's lost first edit; the manifest service's cross-process lock). **SQLite holds identity, not project content** — generated projects stay on the filesystem. |
| 5 | Preview origin | **(a) Same origin, path-based** (`/preview/<projectId>/*`) for now, with (b) documented for later. | Chosen for speed. **Named accepted risk:** today's iframes are cross-origin, which is an *unintentional sandbox*. Same-origin removes it, and the code inside is model-generated from a free-text brief — untrusted input. A prompt injection could plausibly produce a snippet that exfiltrates the stored key using the user's own session. Accepted at invite-only; must be written down as a risk, not an oversight. |
| 6 | API key encryption | **(a) Server master key**, AES-256-GCM, ciphertext in SQLite. | (b) password-derived is stronger but breaks this product: fan-out spawns workers for minutes, runs outlive requests, resumed Kitaru executions can't re-authenticate, and a password reset would destroy the key irrecoverably. Those are the normal path here, not edge cases. |

### Decision 5 — what (b) requires, so it can be executed later

Migrating to a separate preview origin (`<projectId>.preview.example.com`) needs:

1. Wildcard DNS for `*.preview.<domain>`.
2. A wildcard TLS certificate.
3. Session cookie scoped to the preview domain, **or** a short-lived signed
   token in the proxy path.
4. **The shim's `postMessage` target origin tightened from `"*"` to the exact
   preview origin.** It is `"*"` today — harmless same-origin, wrong
   cross-origin. Same for the parent's `postMessage` calls into each frame.
5. The editor's frame-ready/geometry protocol re-checked against a real
   cross-origin boundary; the invariant suite already documents cross-origin
   iframes silently swallowing wheel events, so expect similar surprises.

### Decision 6 — requirements, not intentions

1. The master key lives **only** in an env var or systemd credential — never in
   the repo, the DB, or a committed `.env`. The app **refuses to boot** without
   it rather than falling back to a default.
2. The key is **never logged.** This codebase writes `usage.jsonl` and run logs
   liberally; redact at the boundary where the key is read.
3. Only a **fingerprint** (last 4 chars) is ever returned to the UI, so a
   hijacked session cannot harvest the key.
4. Storing the key is **optional** — paste-per-session must remain possible.
5. **Written limitation:** anyone with root on the VM has both ciphertext and
   master key. Inherent to server-side decryption; what (b) would have fixed.

## Still to decide — recommendations awaiting a yes/no

| # | Question | Recommendation |
|---|---|---|
| 7 | Password hashing | **argon2id** with sensible params. Not bcrypt (72-byte truncation), not a hand-rolled PBKDF2. |
| 8 | Session mechanism | **Server-side sessions in SQLite + `httpOnly`, `SameSite=Lax`, `Secure` cookie.** Not JWT: revocation matters (invite-only means removing someone must take effect immediately) and there is already a DB. |
| 9 | Project ownership | **One owner per project, no sharing in v1.** Sharing is a real feature with its own permission model; do not smuggle it in. |
| 10 | Existing `generated/` projects | **Adopt on first boot**, assigned to a named bootstrap user, rather than orphaned or deleted. There are real acceptance runs on disk worth keeping. |
| 11 | The local CLI path | **Keep it working, unauthenticated, for local dev.** The orchestrator CLIs and `npm run check` must not require a login; auth belongs at the HTTP boundary only. |
| 12 | Who serves the editor | **The same Node process**, so the session cookie is first-party for both the editor and the API. Follows from decision 5. |
| 13 | Concurrent preview cap | **A specific number in the spec** (suggest 6) with a clear error, per decision 3. |

## Next step

Resolve 7–13, then write the spec. Given the security surface, I'd suggest the
spec be one document covering all three slices (they share the same threat
model and data store) but with a task plan that ships **slice 2 alone first** —
accounts with no keys and no tenancy is independently testable, and getting
sessions wrong is much cheaper to discover before key storage depends on them.
