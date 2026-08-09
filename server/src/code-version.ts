// server/src/code-version.ts
/**
 * The server's own code version, computed once at boot (task 7, resume).
 *
 * Exists for exactly one reason: `docs/decisions.md`'s 2026-07-28 row records
 * that reusing a Kitaru run_id across a source-code edit to a checkpoint
 * function is unsafe once that run id has partially executed -- a paired,
 * unchanged-code checkpoint downstream stays cached and silently skips its
 * side effect. `job-routes.ts`'s resume endpoint refuses to resume a job
 * whose OWN recorded code_version (jobs.ts's `recordJobRun`, stamped at the
 * moment the job actually started running) differs from the CURRENT one this
 * module computes -- losing the replay after a deploy is the accepted trade;
 * a corrupt half-replayed manifest is not.
 *
 * "Whatever serve.ts can know at boot" (task-7 brief): an operator-set
 * override takes priority (a deploy pipeline that builds a release artifact
 * -- e.g. stripping .git, or stamping a build id distinct from the source
 * commit -- can set this to whatever it considers authoritative), falling
 * back to the actual git commit `HEAD` points at, since that IS the code
 * that is about to run for every developer/local-server invocation this
 * codebase has today. `git` missing, or this directory not being a repo
 * (a deployed image with `.git` stripped, matching MASTER_KEY_ENV_VAR's own
 * "must not silently degrade" instinct, but with a softer failure mode here:
 * an unknown code version still lets FRESH jobs run) falls back to a fixed,
 * clearly-named sentinel rather than crashing boot over a resume feature
 * nobody may ever use.
 *
 * Task-7-review finding 1 (fixed): the sentinel does NOT, on its own, keep
 * every resume safe when it is in play. Two DIFFERENT boots that both fail
 * to determine a version produce the IDENTICAL string, so a naive `!==`
 * comparison would treat them as a match and permit resuming across
 * arbitrarily many deploys -- exactly the case this whole mechanism exists
 * to refuse. `codeVersionsIncompatible` below is the ONE place that
 * comparison happens, specifically so this failure-open shape cannot recur
 * by a caller writing its own `!==` — see that function's own comment.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Operator override -- see this module's own top comment. Empty/whitespace-only counts as unset, the same convention `usage-log-path.ts`'s own env-override reads already use. */
export const CODE_VERSION_ENV_VAR = "WEBGEN_CODE_VERSION";

/**
 * Returned when neither an override nor a real git HEAD is available.
 * Distinguishable from any real SHA (which is 40 lowercase hex characters)
 * at a glance -- but that is NOT, by itself, proof against a false match:
 * two separate boots that both land on this sentinel produce the IDENTICAL
 * string, so naively comparing `recorded !== current` would treat them as
 * equal and permit a resume that is not actually safe. `codeVersionsIncompatible`
 * below is what closes that hole (task-7-review finding 1): it treats a
 * CURRENT value of this sentinel as unable to vouch for anything, regardless
 * of what the recorded value says.
 */
export const UNKNOWN_CODE_VERSION = "unknown";

// server/src/code-version.ts -> up two directories -> the repo root, the
// same technique job-worker.ts's DEFAULT_ORCHESTRATOR_DIR and preview-pool.ts's
// DEFAULT_PREVIEW_SCRIPT already use, for the same reason: the repo can be
// checked out anywhere, so this must be resolved from the file's own URL,
// never a hardcoded absolute path.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface ResolveCodeVersionDeps {
  /** Defaults to `process.env`. Overridable so a test can supply the override without mutating the real process environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `REPO_ROOT`. Overridable for a test that wants to point at a scratch git repo instead of this one. */
  cwd?: string;
  /** Defaults to a real `git rev-parse HEAD`. Overridable so a test can simulate "git missing" / "not a repo" without touching the real filesystem or spawning a real process. */
  gitRevParse?: (cwd: string) => string;
}

function defaultGitRevParse(cwd: string): string {
  // execFileSync, never a shell string: no interpolation risk, and this
  // matches every other process-spawn in this codebase's own preference for
  // an explicit argv array over shell syntax. Trimming is resolveCodeVersion's
  // own job (applied to whatever gitRevParse returns, injected or not).
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
}

/**
 * Computed fresh on every call -- callers that need ONE stable value across
 * a whole process's lifetime (scripts/serve.ts) call this exactly once at
 * boot and thread the result through, rather than calling it again per
 * request; see compose.ts's and job-worker.ts's own `codeVersion` params.
 */
export function resolveCodeVersion(deps: ResolveCodeVersionDeps = {}): string {
  const env = deps.env ?? process.env;
  const override = env[CODE_VERSION_ENV_VAR];
  if (override !== undefined && override.trim() !== "") {
    return override.trim();
  }

  const gitRevParse = deps.gitRevParse ?? defaultGitRevParse;
  try {
    // Trimmed here, not only inside defaultGitRevParse: an injected
    // gitRevParse (a test double, or a future alternative implementation)
    // should not have to remember to trim its own output for this function's
    // contract to hold -- "whatever produced a sha, we normalize it" is the
    // simpler, less surprising rule.
    const sha = gitRevParse(deps.cwd ?? REPO_ROOT).trim();
    if (sha !== "") return sha;
  } catch {
    // git not installed, this directory not a repo, or a detached/broken
    // HEAD -- any of these is a legitimate "cannot determine" outcome, not a
    // crash. Fall through to the sentinel.
  }
  return UNKNOWN_CODE_VERSION;
}

/**
 * Whether a job recorded to have (partially) run under `recorded` code is
 * UNSAFE to resume/continue under a server currently running `current`.
 * THE single comparison point for this question — job-routes.ts's resume
 * endpoint (an enqueue-time check) and job-worker.ts's `runOnce` (a
 * claim-time re-check, for a job that sat `queued` across a deploy — task-7-
 * review finding 3) both call this rather than each writing their own
 * `!==`, so the two cannot independently drift on what "unsafe" means, and
 * so the fix for finding 1 (below) lives in exactly one place.
 *
 * `recorded === null` means the job never reached `recordJobRun` at all (it
 * failed before any real execution began) — nothing ran, so there is no
 * stale-checkpoint risk to guard against regardless of `current`, and this
 * always returns `false` for that case.
 *
 * Otherwise: a `current` of `UNKNOWN_CODE_VERSION` can never be trusted to
 * match anything, INCLUDING another `UNKNOWN_CODE_VERSION` — see that
 * constant's own comment for why two separate "cannot determine" boots are
 * not evidence the code is actually the same. A plain string mismatch is
 * unsafe by construction (docs/decisions.md, 2026-07-28 row).
 */
export function codeVersionsIncompatible(recorded: string | null, current: string): boolean {
  if (recorded === null) return false;
  return current === UNKNOWN_CODE_VERSION || recorded !== current;
}
