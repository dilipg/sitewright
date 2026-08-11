/**
 * What is left of the 24-hour spend cap, in words — and the one place this app
 * admits when that figure is a FLOOR rather than a total.
 *
 * WHY THIS IS A SHARED MODULE RATHER THAN A FUNCTION ON THE PICKER (which is
 * where it started life, as `describeRemainingBudget`): the BYOK form now shows
 * the same number, and the plan's requirement is that `unpricedEvents` is
 * surfaced "everywhere spend is shown". Two surfaces wording the same fact
 * independently is precisely how one of them ends up presenting a floor as an
 * exact figure — which is the accepted risk this function exists to mitigate,
 * not a style question. One function, both callers, one wording.
 *
 * THE ACCEPTED RISK, stated once here because this is the code that mitigates
 * it: `orchestrator/src/orchestrator/pricing.py` has no Gemini rates. A Gemini
 * run therefore writes `cost_usd = NULL` for every call it makes, and
 * `checkSpendCap`'s total silently omits them — so on a Gemini key the cap does
 * NOT bound spend, and `spentUsd24h` is a lower bound, not a total. That was
 * accepted deliberately in exchange for shipping both providers, ON CONDITION
 * that it is visible. `/api/me` returns `unpricedEvents` for exactly this
 * purpose; ignoring the field turns an honest floor into a confident lie.
 */

/**
 * The money half of `GET /api/me`. Every field is OPTIONAL even though the
 * server always sends all three: this is a parsed network response, and a build
 * talking to an older server must render no line at all rather than `$NaN`.
 */
export interface SpendSummary {
  readonly spendCapUsd?: number;
  readonly spentUsd24h?: number;
  /** Non-zero means `spentUsd24h` is a FLOOR — a model with no published rate
   *  contributed tokens that could not be priced. */
  readonly unpricedEvents?: number;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The remaining budget as a sentence, or `undefined` when there is nothing
 * honest to say.
 *
 * Rendered beside a button that spends ~$1.74, and on the key form beside the
 * provider choice that decides whether the figure can be trusted at all.
 * `requireBudget` refuses an over-cap request with **402, not 429** — retrying
 * cannot help until the window rolls — so a user who cannot see the number finds
 * out by typing a brief and being refused.
 *
 * Four properties, each of which would be a lie if dropped:
 *
 *  - **A missing or non-finite figure renders NOTHING**, never `$NaN` and never
 *    a fabricated zero. An absent cap is not a cap of zero.
 *  - **The remainder is clamped at zero.** `spentUsd24h` can exceed the cap: the
 *    cap gates ENQUEUE, and a run that started under it bills whatever it bills.
 *    "-$0.42 left" reads as a bug; "$0.00 left" is the truth.
 *  - **`unpricedEvents > 0` makes the spend a FLOOR**, not an exact figure. Both
 *    other surfaces that show this number already caveat it (`describeSpendCap`,
 *    the `usage` CLI); a third that did not would be the one place it looks
 *    exact.
 *  - **The caveat says "At least"** in as many words. "3 unpriced calls" is a
 *    fact the reader has to interpret; "the real spend is at least this" is the
 *    conclusion they need before pressing a button.
 */
export function describeSpend(spend: SpendSummary | undefined): string | undefined {
  if (spend === undefined) return undefined;
  const { spendCapUsd: cap, spentUsd24h: spent } = spend;
  if (typeof cap !== "number" || !Number.isFinite(cap)) return undefined;
  if (typeof spent !== "number" || !Number.isFinite(spent)) return undefined;
  const remaining = Math.max(0, cap - spent);
  const base = `${usd(remaining)} of your ${usd(cap)} daily budget is left (${usd(spent)} spent in the last 24 hours).`;
  const unpriced = spend.unpricedEvents;
  if (typeof unpriced === "number" && Number.isFinite(unpriced) && unpriced > 0) {
    return `${base} At least — ${String(unpriced)} call(s) used a model with no published rate, so the real spend is higher.`;
  }
  return base;
}
