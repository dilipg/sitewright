/**
 * The spend cap: $10 per rolling 24 hours by default, per user, overridable
 * (spec, decision 9 and "Spend cap").
 *
 * It gates STARTING work and nothing else. There is deliberately no mid-run
 * check and no kill path: killing a fan-out halfway leaves a half-generated
 * project, which is worse than the overspend. A run that begins under the cap
 * runs to completion even if it ends over it.
 */
import type { DatabaseSync } from "node:sqlite";
import type { User } from "./users.ts";
import { eventsSince, spendSince } from "./usage.ts";

export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SpendStatus {
  allowed: boolean;
  capUsd: number;
  spentUsd: number;
  /**
   * When work becomes possible again, or null when no future instant helps —
   * either because nothing is blocked, or because the cap is zero and no
   * amount of waiting changes that.
   */
  resetAt: number | null;
  unpricedEvents: number;
}

export function checkSpendCap(db: DatabaseSync, user: User, now: number): SpendStatus {
  const capUsd = user.spendCapUsd;
  const since = now - SPEND_WINDOW_MS;
  const window = spendSince(db, user.id, since);

  // A non-positive or corrupt cap means no work, ever — and no reset time,
  // because waiting cannot fix it. Checked before the comparison so that a
  // NaN cap (every comparison against which is false) refuses rather than
  // silently permitting unlimited spend.
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { allowed: false, capUsd, spentUsd: window.costUsd, resetAt: null, unpricedEvents: window.unpricedEvents };
  }

  if (window.costUsd < capUsd) {
    return { allowed: true, capUsd, spentUsd: window.costUsd, resetAt: null, unpricedEvents: window.unpricedEvents };
  }

  return {
    allowed: false,
    capUsd,
    spentUsd: window.costUsd,
    resetAt: resetAtFor(db, user.id, since, window.costUsd, capUsd),
    unpricedEvents: window.unpricedEvents,
  };
}

/**
 * The earliest instant at which the trailing-24h spend drops below the cap.
 *
 * Exact rather than estimated, and it can be: spend only ever DECREASES as
 * the window slides, because every recorded event is already in the past. So
 * walking the in-window events oldest-first and subtracting until the
 * remainder is under the cap identifies precisely which event's expiry
 * unblocks the user.
 *
 * The `+ 1` is not a fudge. `spendSince` uses `at >= since`, so at the
 * instant `event.at + SPEND_WINDOW_MS` the boundary still includes that
 * event; one millisecond later is the first moment it does not. The test
 * asserting `checkSpendCap(resetAt).allowed && !checkSpendCap(resetAt - 1).allowed`
 * is what holds this honest.
 *
 * With a positive cap the loop always returns, because dropping every event
 * leaves 0, which is below any positive cap.
 */
function resetAtFor(
  db: DatabaseSync,
  userId: string,
  since: number,
  spentUsd: number,
  capUsd: number,
): number | null {
  let remaining = spentUsd;
  for (const event of eventsSince(db, userId, since)) {
    remaining -= event.costUsd ?? 0;
    if (remaining < capUsd) return event.at + SPEND_WINDOW_MS + 1;
  }
  return null;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The refusal, in words. The spec requires all three numbers: "Insufficient
 * budget" with no numbers produces a support conversation instead of an
 * obvious action.
 */
export function describeSpendCap(status: SpendStatus): string {
  const head = `spend cap reached: ${usd(status.spentUsd)} spent of ${usd(status.capUsd)} in the last 24 hours`;
  if (status.resetAt === null) {
    return `${head}; no further work is permitted until an operator raises the cap`;
  }
  return `${head}; resets at ${new Date(status.resetAt).toISOString()}`;
}
