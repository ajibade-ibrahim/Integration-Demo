/**
 * Rendering a stored price as a person would say it: "$49/month".
 *
 * This lives in core rather than in the Stripe provider because two callers
 * need the identical string and must not drift apart:
 *
 *   - `offeringDisplayName` synthesizes `Offering.name` at sync time, because
 *     Stripe's `nickname` is usually null and the column is required.
 *   - `formatOfferingPrice` renders the price column on /catalog at read time,
 *     from `amountMinor` + `currency` + `interval`.
 *
 * The same offering therefore shows the same words in its name and in its
 * price. When these were two implementations they had already been written
 * twice, and a change to one would have left the other showing a different
 * string for the same row.
 */

/**
 * Format a minor-unit amount in its own currency.
 *
 * `Intl.NumberFormat` is doing real work here rather than being decoration: the
 * number of minor units in a major one is currency-specific. JPY and KRW have
 * none, so 4900 JPY is ¥4,900 and not ¥49.00, and a hardcoded division by 100
 * would misprice every zero-decimal currency by a factor of a hundred.
 * `resolvedOptions()` knows the right exponent for each.
 *
 * `minimumFractionDigits: 0` drops cents only when there are none to show, so
 * 4900 is "$49" while 4999 stays "$49.99". Nothing is lost by it — "$49" can
 * only have come from a whole number of dollars — and it is how a price is
 * written wherever a person rather than a ledger is reading it. Note that it
 * does not move `maximumFractionDigits`, which stays at the currency's own
 * exponent and is what the division below depends on.
 *
 * @returns undefined for a currency code Intl rejects, so the caller can fall
 *   back rather than render "NaN".
 */
export function formatMoney(
  amountMinor: number,
  currency: string
): string | undefined {
  try {
    const format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    // RangeError for an unknown code. Not worth failing a record over.
    return undefined;
  }
}

/**
 * The recurrence, as a suffix: "/month", "/3 months", or "" for a price that
 * does not recur.
 *
 * Unspaced, which is the form a pricing page uses. `one_time` returns empty
 * rather than "/one_time" — a one-time price has a recurrence, and the
 * recurrence is "none", so the honest rendering of it is to say nothing.
 */
export function formatInterval(
  interval: string | null | undefined,
  intervalCount: number | null | undefined
): string {
  if (interval === null || interval === undefined || interval === "one_time") {
    return "";
  }
  const count = intervalCount ?? 1;
  // "every 3 months" pluralizes; "every 1 month" is just "month". Interval
  // names are the five values in BILLING_INTERVALS, all of which take a plain
  // "s", so there is no irregular case to handle.
  return count > 1 ? `/${count} ${interval}s` : `/${interval}`;
}

/**
 * Amount and recurrence together: "$49/month", "$15/3 months", "$49".
 *
 * @returns undefined when there is no amount, or no currency to interpret one
 *   with. An amount alone is not a price, and neither is a currency.
 */
export function priceLabel(parts: {
  amountMinor: number | null | undefined;
  currency: string | null | undefined;
  interval?: string | null;
  intervalCount?: number | null;
}): string | undefined {
  const { amountMinor, currency } = parts;
  if (typeof amountMinor !== "number" || !currency) return undefined;

  const money = formatMoney(amountMinor, currency);
  if (money === undefined) return undefined;

  return `${money}${formatInterval(parts.interval, parts.intervalCount)}`;
}
