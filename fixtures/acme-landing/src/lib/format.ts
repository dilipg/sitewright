/**
 * Site-wide display formatting for values that are NUMBERS in your data and
 * strings only at the moment they are rendered.
 *
 * Why this file exists: a section may not put user-visible strings in its JSX
 * (contract 4.3), so a price written as `{price} × {quantity}` is a contract
 * violation — the "×" is hardcoded copy. Combining them into one pre-formatted
 * mock-data string satisfies the rule but only MOVES the problem: the currency
 * symbol and the separator end up in whoever supplies the data, per page,
 * unreachable from any shared config. Two independent handover trials hit this
 * from opposite ends (docs/reports/m6-handover-trial.md).
 *
 * So: keep money and counts as numbers in data, and format here. The separator
 * and the currency live in one place, outside section JSX, and an integration
 * that swaps mock data for an API keeps working without touching a component.
 */

/** Change these two to re-denominate the whole site. */
export const MONEY_LOCALE = "en-US";
export const MONEY_CURRENCY = "USD";

/**
 * Formats an amount in MAJOR units (dollars, euros — not cents).
 * Whole amounts render without decimals ("$32"), fractional ones with two
 * ("$32.50"), which is what storefront copy conventionally does.
 */
export function formatMoney(amount: number): string {
  return new Intl.NumberFormat(MONEY_LOCALE, {
    style: "currency",
    currency: MONEY_CURRENCY,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** A cart/line-item price line: "$32" for one, "$32 × 2" for more. */
export function formatPriceLine(unitPrice: number, quantity: number): string {
  return quantity === 1 ? formatMoney(unitPrice) : `${formatMoney(unitPrice)} × ${quantity}`;
}

/** Sums line items — the arithmetic a section deliberately never does. */
export function sumLineItems(items: Array<{ unitPrice: number; quantity: number }>): number {
  return items.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
}
