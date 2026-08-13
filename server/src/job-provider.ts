// server/src/job-provider.ts
/**
 * Which model provider a job ran under, and whether a resume may continue it.
 *
 * FIX ROUND B, I7. `code-version.ts`'s exact sibling, deliberately shaped the
 * same way, because it guards the same thing for the same reason: Kitaru keys
 * its checkpoint cache on function code plus args, so reusing a `run_id` after
 * something about the execution changed leaves the completed checkpoints cached
 * under the OLD conditions while the failed one re-executes under the new ones.
 * `code_version` covers "the server's code changed". This covers "the model
 * FAMILY changed", which the code version cannot see at all: a user replaces
 * their Anthropic key with a Gemini one between a failed job and its resume, and
 * `buildAgentEnv` — resolved at claim time, from whatever key is stored THEN —
 * sends the resumed run to a different provider entirely. The result is one
 * site, one `run_id`, half written by each family.
 *
 * `providersIncompatible` is THE single comparison point, exactly as
 * `codeVersionsIncompatible` is and for the same stated reason: two call sites
 * (`job-routes.ts`'s resume endpoint at ENQUEUE time, `job-worker.ts`'s
 * `runClaimedJob` at CLAIM time — the second closes the window in which a
 * resumed job sits `queued` while the key is swapped, the identical hole
 * task-7-review finding 3 found for code versions) must not each write their own
 * `!==` and drift on what "unsafe" means.
 *
 * `currentProviderFor` is the single RESOLUTION point, for the same
 * anti-drift reason. It reads the display-only `getApiKeyFingerprint`, which
 * takes no master key — so nothing in this guard is capable of decrypting a
 * credential, and no key material is read, logged or persisted anywhere in this
 * module.
 */
import type { DatabaseSync } from "node:sqlite";
import { getApiKeyFingerprint, isApiKeyProvider, type ApiKeyProvider } from "./api-keys.ts";

/**
 * The provider a run started now would use for `userId`, or `null` when no key
 * is stored at all.
 *
 * Deliberately the DISPLAY-only read (`getApiKeyFingerprint`, no master key)
 * rather than `resolveApiKey`/`getApiKeyPlaintext`: this answers "which family",
 * which lives in its own column, and a guard that never decrypts cannot leak
 * what it never held. It is also the SAME read `PreviewPool.acquire` compares a
 * warm child against when deciding whether that child's credential has gone
 * stale, so what a job records is what the pool will spawn for.
 */
export function currentProviderFor(db: DatabaseSync, userId: string): ApiKeyProvider | null {
  return getApiKeyFingerprint(db, userId)?.provider ?? null;
}

/**
 * Whether a job recorded to have (partially) run under `recorded` is UNSAFE to
 * resume/continue under `current`.
 *
 * Read the three carve-outs, because each is a decision rather than a fallback:
 *
 * - `recorded === null` returns **false**, the same carve-out
 *   `codeVersionsIncompatible` makes and for the identical reason: null means
 *   the job never reached `recordJobRun`, so no model call was ever made under
 *   it and there is no half-written cache to protect. It is also what every
 *   pre-column row and every `export` job carries (an export spends nothing and
 *   calls no model), and refusing on it would break every legitimate resume
 *   those describe.
 * - A `recorded` value that is not a member of the union returns **true**. Fail
 *   closed, mirroring `api-keys.ts`'s `providerOfRow`: unreachable while the
 *   column's CHECK holds (db.ts), so this covers a hand-edited database, where
 *   guessing is exactly the mistake that sends one family's work to another.
 * - `current === null` returns **false**, and this one is NOT a hole. It means
 *   the user has no key stored at all, so the resume cannot run whatever this
 *   function says — `job-worker.ts`'s `assertApiKeyUsable`/`buildAgentEnv`
 *   refuses it with an actionable missing-key message. Answering 409 here
 *   instead would name a provider the account does not have and hide the one
 *   fact the user can act on.
 *
 * `recorded` is typed as a bare `string` while `current` is the validated union,
 * on purpose: a value read out of a row cannot be trusted the way a value
 * resolved through `api-keys.ts` can.
 */
export function providersIncompatible(recorded: string | null, current: ApiKeyProvider | null): boolean {
  if (recorded === null) return false;
  if (!isApiKeyProvider(recorded)) return true;
  if (current === null) return false;
  return recorded !== current;
}

/**
 * The refusal message, NAMING BOTH PROVIDERS — the whole point of the
 * fix-round-B item, since "cannot be resumed" alone leaves a user with no way to
 * work out that swapping their key is what did it.
 *
 * Built here rather than at either call site so the 409 body (`job-routes.ts`)
 * and the failed-job error (`job-worker.ts`) cannot word the same fact
 * differently. `recorded` is printed as whatever the row actually holds, so the
 * hand-edited-database case reads honestly rather than being smoothed into a
 * real provider's name. Names no key and no fingerprint: a provider is a choice,
 * not a credential, but nothing here needs the credential either.
 */
export function describeProviderMismatch(recorded: string, current: ApiKeyProvider | null): string {
  const now = current ?? "none";
  return `this job ran with a ${recorded} key and this account now uses ${now}; a resume continues `
    + "the same run, which cannot switch model providers partway — start a fresh job instead";
}
