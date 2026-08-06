// server/src/usage-log-sweep.ts
/**
 * Clears out `<tmpdir>/webgen-usage` at server startup — the honest disposal
 * for a usage log a billable request's `after()` never got to ingest.
 *
 * FIX 3 (whole-branch review): `compiler-routes.ts`'s billable forward skips
 * `ingestUsageLog` when the proxied exchange settled WITHOUT the upstream
 * response actually finishing (a client abort, or `PREVIEW_PROXY_TIMEOUT_MS`)
 * — see `preview-forward.ts`'s module comment. `ingestUsageLog` is
 * deliberately NOT idempotent (ingest-usage.ts), so a request handler can
 * never safely retry ingesting a file it once skipped: the orchestrator
 * subprocess underneath is very likely still appending to it, and reading it
 * now would ingest a PARTIAL file and then delete it, silently dropping
 * every later line. Skipping the delete instead just leaves the file
 * sitting there forever.
 *
 * By the time the server restarts, the user/project context that would let
 * anyone attribute that file's spend correctly is gone — this is a fresh
 * process with no memory of which request produced it. Ingesting it blind
 * would risk billing the wrong account (or none). Deleting it unread is the
 * only honest option left, and it is the same trade `compiler-routes.ts`
 * already makes when a run made no model calls at all (a legitimate no-op)
 * — the difference here is silence about a WINDOW of usage this sweep
 * accepts as lost, not a bug being hidden.
 *
 * Runs once, at boot, before the pool (or any route) exists — nothing can
 * yet be writing into this directory for THIS server process, so there is
 * no live file to race.
 */
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { usageLogDir } from "../../compiler/src/usage-log-path.ts";

export interface SweepResult {
  /** Files removed. */
  swept: number;
}

export function sweepStaleUsageLogs(dir: string = usageLogDir()): SweepResult {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Doesn't exist yet — no billable request has ever run against this
    // host. Not an error: the directory is created on demand by whichever
    // request writes the first log (compiler/src/usage-log-path.ts).
    return { swept: 0 };
  }

  let swept = 0;
  for (const name of names) {
    try {
      unlinkSync(join(dir, name));
      swept += 1;
    } catch {
      // Best-effort: a file another process still holds open (a subprocess
      // from a run this same restart just interrupted), or one that vanished
      // between readdirSync and this unlink, is not fatal to boot — leave it
      // for the NEXT restart's sweep rather than fail startup over cleanup.
    }
  }
  return { swept };
}
