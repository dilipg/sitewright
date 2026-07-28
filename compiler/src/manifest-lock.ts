/**
 * Cross-process advisory lock for manifest.json's read-modify-write cycle.
 * "Pages are parallel to each other" (pipeline 2.5) means multiple OS
 * processes commit to the SAME manifest.json concurrently (build prompt
 * 5.3's fan-out); without serialization, two commits racing lose one
 * writer's proposals entirely. Portable via exclusive file creation
 * (O_EXCL), which is atomic on both POSIX and Windows.
 */

import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";

export interface LockOptions {
  /** Give up and throw after this long waiting for the lock. */
  timeoutMs?: number;
  /** Poll interval while waiting. */
  retryDelayMs?: number;
  /** A lock file older than this is presumed abandoned by a crashed holder and is stolen. */
  staleMs?: number;
}

const DEFAULTS: Required<LockOptions> = { timeoutMs: 10_000, retryDelayMs: 25, staleMs: 30_000 };

/** Synchronous sleep. Atomics.wait on the main thread is Node-only (browsers forbid it). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false; // vanished between our EEXIST and this stat — not stale, just gone
  }
}

function acquire(lockPath: string, options: Required<LockOptions>): void {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(lockPath, options.staleMs)) {
        try {
          unlinkSync(lockPath);
          continue; // retry acquisition immediately; another waiter may win, that's fine
        } catch {
          // lost the race to remove it — fall through to normal wait/retry
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${options.timeoutMs}ms waiting for manifest lock at ${lockPath}. ` +
            "Another process may be stuck; delete the lock file if you're certain it's abandoned.",
        );
      }
      sleepSync(options.retryDelayMs);
    }
  }
}

/** Runs fn() holding an exclusive lock on manifestPath's commit cycle. Releases on success or throw. */
export function withManifestLock<T>(manifestPath: string, fn: () => T, options: LockOptions = {}): T {
  const resolved = { ...DEFAULTS, ...options };
  const lockPath = `${manifestPath}.lock`;
  acquire(lockPath, resolved);
  try {
    return fn();
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}
