/**
 * Metrifox REST specifics: base URL, pagination, and the flattening of nested
 * contact people into standalone records.
 *
 * Docs: https://docs.metrifox.com/api-reference/customers/get
 */

import type { RawRecord } from '../../types/common'
import { asArray, asRecord, asString } from '../http'

/** Records per page. Metrifox's own default is 25. */
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

/**
 * Runaway guard. Cursor pagination terminates when the cursor is absent, but
 * page numbers have no natural end — a provider echoing `next_page` forever
 * would page until the process died.
 */
export const METRIFOX_MAX_PAGES = 1000

/** How many customers discovery samples to find tenant-specific metadata keys. */
export const METRIFOX_DISCOVERY_SAMPLE = 25

/**
 * Base URL for the Metrifox API.
 *
 * Overridable so tests and the built-in fake can point elsewhere, exactly like
 * `hubspotApiBase()`.
 */
export function metrifoxApiBase(): string {
  const base = process.env['METRIFOX_API_BASE']
  const resolved =
    base === undefined || base === ''
      ? 'https://api-staging.metrifox.com'
      : base

  // The API key travels in a header on every one of these requests. A base
  // that is neither HTTPS nor loopback would put a live credential on the
  // wire in clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved)
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1'
  if (protocol !== 'https:' && !loopback) {
    throw new Error(
      `METRIFOX_API_BASE must use https (or localhost); got '${resolved}'`,
    )
  }
  return resolved
}

export function metrifoxPageSize(): number {
  const raw = process.env['METRIFOX_PAGE_SIZE']
  if (raw === undefined || raw === '') return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

export function customersUrl(page: number, perPage: number): string {
  // Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
  // base's own path entirely, which would silently strip the `/api/fake/...`
  // prefix the built-in fake is mounted under.
  const url = new URL(
    `${metrifoxApiBase().replace(/\/$/, '')}/api/v1/customers`,
  )
  url.searchParams.set('page', String(page))
  url.searchParams.set('per_page', String(perPage))
  return url.toString()
}

export interface MetrifoxPage {
  readonly customers: readonly RawRecord[]
  /** Next page number, or undefined on the last page. */
  readonly nextPage: number | undefined
}

/**
 * Read one customers response.
 *
 * `meta.next_page` is the provider's own end-of-data signal, the way HubSpot
 * uses the absence of `paging.next.after`. It is trusted over `total_pages`
 * because it is the field the API documents as authoritative.
 */
export function parseCustomersPage(json: unknown): MetrifoxPage {
  const body = asRecord(json)
  const data = asArray(body?.['data'])
  const meta = asRecord(body?.['meta'])

  const next = meta?.['next_page']
  return {
    customers: data.filter(
      (row): row is RawRecord => asRecord(row) !== undefined,
    ),
    nextPage: typeof next === 'number' && next > 0 ? next : undefined,
  }
}

// ---------------------------------------------------------------------------
// Contact flattening
// ---------------------------------------------------------------------------

/**
 * The stable synthetic id for one nested contact person.
 *
 * ALGORITHM v1 — changing any of this re-keys every existing Metrifox contact.
 * `Contact` is unique on `(integrationId, externalSourceId)`, so an id that
 * shifts between runs does not error: it silently inserts a duplicate person
 * and orphans the old row. That is why the array index is the last resort
 * rather than the obvious first choice — inserting one contact person would
 * renumber every contact after it.
 *
 * Prefixing with the customer id is deliberate. The same person listed under
 * two customers becomes two Contact rows, which is correct: our `Contact`
 * holds exactly one `customerId`, and the source really is asserting two
 * distinct relationships.
 *
 * @param taken Slots already used by earlier people on this same customer, so
 *   two contacts sharing an email cannot collide. The first occurrence keeps
 *   the clean id, so a later duplicate never destabilises an existing row.
 */
export function metrifoxContactExternalId(
  customerId: string,
  person: RawRecord,
  index: number,
  taken: Set<string>,
): string {
  const email = asString(person['email_address'])?.trim().toLowerCase()

  let slot: string
  if (email !== undefined && email !== '') {
    // The only field that is both usually present and genuinely identifying.
    slot = email
  } else {
    const name = [
      asString(person['first_name']),
      asString(person['last_name']),
      asString(person['designation']),
    ]
      .map((part) => part?.trim().toLowerCase() ?? '')
      .join('|')
    // Stable as long as nobody is renamed — far better than an index. A person
    // with neither email nor name is rejected downstream for a missing name
    // anyway; the index branch exists so this function is total.
    slot = name === '||' ? `#${index}` : name
  }

  const candidate = `${customerId}:${slot}`
  return taken.has(candidate) ? `${candidate}#${index}` : candidate
}

/**
 * Flatten one customer's `contact_people[]` into standalone contact records.
 *
 * The engine calls `externalIdOf(record)` with the raw record alone — it has no
 * access to the parent or the index — so the synthesized id has to be embedded
 * in the record rather than computed later.
 *
 * `full_name` is synthesized here too. `Contact.name` is required, and Metrifox
 * splits names the way HubSpot does; because we are already building the record
 * we can join it once, correctly, instead of warning users that surnames vanish.
 */
export function flattenContacts(customer: RawRecord): RawRecord[] {
  const customerId = asString(customer['id'])
  if (customerId === undefined) return []

  const people = asArray(customer['contact_people'])
  const taken = new Set<string>()
  const flattened: RawRecord[] = []

  people.forEach((entry, index) => {
    const person = asRecord(entry)
    if (person === undefined) return

    const contactId = metrifoxContactExternalId(
      customerId,
      person,
      index,
      taken,
    )
    taken.add(contactId)

    const fullName = [
      asString(person['first_name'])?.trim(),
      asString(person['last_name'])?.trim(),
    ]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ')

    flattened.push({
      ...person,
      contact_id: contactId,
      full_name: fullName,
      customer_id: customerId,
      ...(asString(customer['customer_key']) !== undefined
        ? { customer_key: customer['customer_key'] }
        : {}),
    })
  })

  return flattened
}

// ---------------------------------------------------------------------------
// Agreements (subscriptions, their lines, their effective entitlements)
//
// The public API has no list endpoint for subscriptions. The only list-shaped
// source is `GET /api/v1/customers/{customer_key}/details`, which groups a
// customer's subscriptions by product: a current `subscription` beside a
// `subscriptions_history[]`. So the handler pages customers and fans out one
// details request per customer — see `agreement-handler.ts` for the cost and
// the completeness rules that fan-out forces.
//
// Entitlements are one more fan-out level: `GET
// /api/v1/subscriptions/{subscription_id}/v2/entitlements-summary` is per
// subscription and has no list form either.
// ---------------------------------------------------------------------------

/**
 * One customer's detail payload, with each subscription group kept intact.
 *
 * Groups are preserved rather than flattened here because order matters to the
 * handler: the current subscription must be read before its history, or a stale
 * copy of a subscription could overwrite the fresher one. A parser that
 * returned one array would have thrown that away.
 */
export interface MetrifoxSubscriptionGroup {
  readonly current: RawRecord | undefined;
  readonly history: readonly RawRecord[];
}

export interface MetrifoxCustomerDetails {
  /**
   * `undefined` means the response was malformed rather than an empty account:
   * `data.subscriptions` was present but not an array. The handler skips that
   * customer and counts it as unusable, because "we could not read this
   * customer" and "this customer has no subscriptions" are different facts.
   *
   * A missing `data.subscriptions` is `[]`: the API tolerates a customer with
   * no products, and absence there is ordinary.
   */
  readonly groups: readonly MetrifoxSubscriptionGroup[] | undefined;
}

/** The details URL for one customer. The key is a path segment, so encoded. */
export function customerDetailsUrl(customerKey: string): string {
  return new URL(
    `${metrifoxApiBase().replace(/\/$/, "")}/api/v1/customers/${encodeURIComponent(
      customerKey
    )}/details`
  ).toString();
}

/** The effective-entitlement summary for one subscription. */
export function subscriptionEntitlementsSummaryUrl(subscriptionId: string): string {
  return new URL(
    `${metrifoxApiBase().replace(
      /\/$/,
      ""
    )}/api/v1/subscriptions/${encodeURIComponent(
      subscriptionId
    )}/v2/entitlements-summary`
  ).toString();
}

/**
 * Read one customer's details response.
 *
 * Both degrades are deliberate and narrow: a missing or non-record `current`
 * subscription is skipped, and a missing/non-array `subscriptions_history` is
 * an empty history. Neither is a malformed response — the API may omit a
 * `subscription` for a product the customer has churned out of entirely.
 *
 * The top-level `subscriptions` is different. Missing means "no products"
 * (empty); present and non-array means we cannot interpret the payload at all,
 * so `groups` is `undefined` and the caller must not pretend the customer has
 * no subscriptions.
 */
export function parseCustomerDetails(json: unknown): MetrifoxCustomerDetails {
  const body = asRecord(json);
  const data = asRecord(body?.["data"]);
  const subscriptions = data?.["subscriptions"];

  if (subscriptions === undefined) return { groups: [] };
  if (!Array.isArray(subscriptions)) return { groups: undefined };

  const groups: MetrifoxSubscriptionGroup[] = [];
  for (const entry of subscriptions) {
    const group = asRecord(entry);
    if (group === undefined) continue;

    groups.push({
      current: asRecord(group["subscription"]),
      history: recordsOf(group["subscriptions_history"]),
    });
  }

  return { groups };
}

/**
 * Read one entitlements-summary response.
 *
 * `undefined` is not an empty list: it means a 200 whose `data` was not an
 * array. The handler treats that as `complete: false`, because a body we could
 * not read must never license deleting rows we did read last time.
 */
export function parseEntitlementsSummary(json: unknown): readonly RawRecord[] | undefined {
  const body = asRecord(json);
  const data = body?.["data"];
  if (!Array.isArray(data)) return undefined;
  return recordsOf(data);
}

/** Records out of an unknown array, skipping anything malformed. */
function recordsOf(value: unknown): readonly RawRecord[] {
  return asArray(value).filter((row): row is RawRecord => asRecord(row) !== undefined);
}

/**
 * Metrifox's subscription words, mapped onto ours.
 *
 * The API's documented vocabulary and its webhook samples disagree on spelling,
 * so both `canceled` and `cancelled` are accepted, and separators are collapsed
 * before lookup. Two translations are judgement calls rather than one-to-one:
 *
 *   `delinquent` → `past_due` — the docs describe a payment that could not be
 *   collected, which is exactly our `past_due`.
 *
 *   `deactivated` → `canceled` — the docs describe a subscription that ended,
 *   typically after a cancellation took effect. `expired` would claim it ran
 *   its term, which is a different fact.
 *
 * `grace`/`grace_period` → `active`: the docs say the subscription is still in
 * service. Anything unrecognised returns `undefined`, so no mapping rule fires
 * and the writer never sees a word it would warn about; the raw word is still
 * kept in `raw_status`.
 */
const METRIFOX_AGREEMENT_STATUS: Readonly<Record<string, string>> = {
  active: "active",
  trial: "trialing",
  trialing: "trialing",
  in_trial: "trialing",
  paused: "paused",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
  delinquent: "past_due",
  deactivated: "canceled",
  grace: "active",
  grace_period: "active",
};

/** One lowercased, underscore-collapsed word for the status table. */
function normalizeWord(value: unknown): string | undefined {
  const raw = asString(value)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  return raw.replace(/[\s-]+/g, "_");
}

export function metrifoxAgreementStatus(status: unknown): string | undefined {
  const word = normalizeWord(status);
  return word === undefined ? undefined : METRIFOX_AGREEMENT_STATUS[word];
}

/**
 * A display name for the agreement.
 *
 * Both candidates are provider-stated: `plan_name` first, then `product_name`.
 * Nothing is synthesized from the id — an unnamed subscription is rejected by
 * the required `Agreement.name` check, visibly, which is better than inventing
 * a label that reads like a Metrifox fact.
 */
export function metrifoxAgreementName(subscription: RawRecord): string | undefined {
  const plan = asString(subscription["plan_name"])?.trim();
  if (plan !== undefined && plan !== "") return plan;

  const product = asString(subscription["product_name"])?.trim();
  return product === undefined || product === "" ? undefined : product;
}

/** Trimmed string or undefined, so blank provider values are treated as absent. */
function trimmedString(value: unknown): string | undefined {
  const raw = asString(value)?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/** A finite number, or undefined. Used for payload numbers kept verbatim. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A number as a string, when the provider actually stated one.
 *
 * Deliberately not `String(value)`: that would turn `null` into `"null"` and an
 * absent `usage_limit` into a limit. `undefined` means "not numeric".
 */
function numericString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return trimmed;
  }
  return undefined;
}

/**
 * A curated JSON bag for a `providerMetadata` column.
 *
 * Curated rather than the whole payload because the column is capped at 1000
 * characters, and `undefined` entries are dropped so an absent fact does not
 * become the string `"null"`. An empty bag returns `undefined`, which leaves
 * the column null instead of storing `{}`.
 */
export function metrifoxJson(bag: Readonly<Record<string, unknown>>): string | undefined {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (value !== undefined) pruned[key] = value;
  }
  return Object.keys(pruned).length === 0 ? undefined : JSON.stringify(pruned);
}

/**
 * The synthesized fields for one subscription, shared by `agreement` and
 * `subscription`.
 *
 * Every date and status here is provider-stated and passed through, with one
 * exception: `status` is translated into our vocabulary while `raw_status`
 * keeps Metrifox's own word. Nothing is derived. `billing_period`,
 * `billing_period_count`, `collection_method`, header `quantity`, `cancel_at`,
 * `cancel_at_period_end` and `trial_starts_at` are deliberately absent:
 * `SubscriptionView` states none of them, so a value there would be a guess.
 *
 * `item_count` is injected only when `subscription_items` is an array. An
 * absent or non-array key is not zero lines — it is "not told" — and writing 0
 * would contradict the item page's own `complete: false`.
 *
 * `customer_id` is the customers-list `id`, injected by the caller. It is not
 * the details payload's `metrifox_id`/`customer_key`: identity keys customers
 * on the list id, so any other choice leaves the agreement's customer link
 * permanently unresolved.
 */
export function flattenMetrifoxSubscription(
  subscription: RawRecord,
  customerId: string
): RawRecord {
  const status = metrifoxAgreementStatus(subscription["status"]);
  const rawStatus = asString(subscription["status"]);
  const name = metrifoxAgreementName(subscription);

  const providerMetadata = metrifoxJson({
    product_key: asString(subscription["product_key"]),
    product_name: asString(subscription["product_name"]),
    plan_name: asString(subscription["plan_name"]),
    plan_version: subscription["plan_version"],
    offering_key: asString(subscription["offering_key"]),
    next_billing_amount: finiteNumber(subscription["next_billing_amount"]),
    next_billing_date: asString(subscription["next_billing_date"]),
    raw_status: rawStatus,
  });

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["effective_date", "starts_at"],
    ["end_date", "ends_at"],
    ["current_period_start", "current_billing_period_start"],
    ["current_period_end", "current_billing_period_end"],
    ["next_billing_at", "renews_at"],
    ["trial_ends_at", "trial_end_date"],
    ["canceled_at", "cancelled_at"],
  ] as const) {
    const iso = asString(subscription[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }

  const itemCount = Array.isArray(subscription["subscription_items"])
    ? subscription["subscription_items"].length
    : undefined;

  return {
    ...(name === undefined ? {} : { agreement_name: name }),
    agreement_type: "subscription",
    // Always written, even as `undefined`. The handler spreads the raw record
    // first, so a bare omission would let an unrecognised provider word survive
    // in `status` and reach the enum validator — exactly the warning storm the
    // omission is meant to avoid. An explicit undefined overrides it, and the
    // provider's own word stays reachable in `raw_status`.
    status,
    ...(rawStatus === undefined ? {} : { raw_status: rawStatus }),
    customer_id: customerId,
    ...(itemCount === undefined ? {} : { item_count: itemCount }),
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
    ...dates,
  };
}

/**
 * A subscription's inline lines.
 *
 * The array is optional, so the caller must also ask whether the key was
 * present (and an array) before treating an empty result as "no lines" — see
 * the handler's completeness gate.
 */
export function subscriptionItems(
  subscription: RawRecord
): readonly RawRecord[] {
  return recordsOf(subscription["subscription_items"]);
}

/**
 * The stable synthetic id for one subscription line.
 *
 * ALGORITHM v1 — changing this re-keys every existing Metrifox line.
 * `AgreementItem` is unique on `(integrationId, externalSourceId)`, and
 * `subscription_items[]` elements carry no id at all. `price_option_id` is the
 * only stable per-line identifier; position is the fallback, and a blank id is
 * treated as absent.
 *
 * Two lines sharing a price option would collide and the later row would win.
 * The API's shape does not currently allow it, and defending against it would
 * need an id the payload does not carry, so it is documented rather than
 * papered over.
 */
export function metrifoxAgreementItemId(
  subscriptionId: string,
  priceOptionId: unknown,
  position: number
): string {
  const priceId = trimmedString(priceOptionId);
  return `${subscriptionId}:${priceId ?? `pos${position}`}`;
}

/**
 * The synthesized fields for one inline subscription item.
 *
 * `item_type` is translated only where Metrifox is unambiguous: a
 * `source_type` ending in `Offerings::Plan` is a plan line, and
 * `is_addon === true` is an add-on. Anything else stays null — null means "not
 * told", never a guess, which is why `source_type` is not pattern-matched more
 * aggressively.
 *
 * Money is left in `provider_metadata` and never becomes `unitPriceMinor`:
 * Metrifox states `unit_price` in standard units and this payload has no
 * currency exponent for the line, so a conversion would be a guess. The
 * discovery labels say "standard units" for the same reason.
 *
 * `offering_id` is injected only on a plan line: it is the subscription's
 * `offering_key`, and an add-on line must not claim the plan's offering.
 */
export function flattenMetrifoxSubscriptionItem(
  item: RawRecord,
  subscriptionId: string,
  offeringKey: string | undefined,
  position: number
): RawRecord {
  const sourceType = asString(item["source_type"]);
  const itemType =
    sourceType !== undefined && sourceType.endsWith("Offerings::Plan")
      ? "plan"
      : item["is_addon"] === true
        ? "add_on"
        : undefined;

  const priceId = trimmedString(item["price_option_id"]);

  const providerMetadata = metrifoxJson({
    name: asString(item["name"]),
    source_type: sourceType,
    source_id: asString(item["source_id"]),
    is_addon: typeof item["is_addon"] === "boolean" ? item["is_addon"] : undefined,
    unit_price: finiteNumber(item["unit_price"]),
    total_amount: finiteNumber(item["total_amount"]),
    currency_code: asString(item["currency_code"]),
    pricing: item["pricing"],
  });

  return {
    item_id: metrifoxAgreementItemId(subscriptionId, priceId, position),
    agreement_id: subscriptionId,
    ...(priceId === undefined ? {} : { price_id: priceId }),
    ...(itemType === "plan" && offeringKey !== undefined
      ? { offering_id: offeringKey }
      : {}),
    ...(itemType === undefined ? {} : { item_type: itemType }),
    position,
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
  };
}

/**
 * The synthesized fields for one effective-entitlement row.
 *
 * `value` is the quantity this subscriber holds — `purchased_qty` — because
 * that is what `/agreements` renders.
 *
 * `limit_value` is the dangerous one. The writer derives `limitValue` from
 * `limitValue ?? value`, so mapping `usage_limit` only when it is set would
 * silently turn a null (unlimited) limit into the purchased quantity as a hard
 * limit. The injected `limit_value` is therefore always present: the numeric
 * `usage_limit` when stated, otherwise the non-numeric sentinel `"unlimited"`,
 * which `parseInteger` leaves null without a warning.
 *
 * The row is keyed by the summary row's own `id`. `entitlement_id` is never a
 * key — it is the feature definition's id and repeats across subscriptions.
 * When the row id is absent, `entitlement_row_id` is injected from the
 * subscription and feature, which is stable enough for the writer's reconcile
 * to replace an old row rather than duplicate it.
 *
 * `feature_id` is the raw `feature_key`. `isOverride` and `valueName` are
 * omitted: the payload states neither, and `feature_name` is the feature's
 * name, not an entitlement-level label.
 */
export function flattenMetrifoxAgreementEntitlement(
  row: RawRecord,
  subscriptionId: string,
  position: number
): RawRecord {
  const featureKey = asString(row["feature_key"]);
  const value = numericString(row["purchased_qty"]);
  const limitValue = numericString(row["usage_limit"]) ?? "unlimited";

  const rowId =
    asString(row["id"]) === undefined
      ? `${subscriptionId}:${featureKey ?? `pos${position}`}`
      : undefined;

  const providerMetadata = metrifoxJson({
    included_allowance: row["included_allowance"],
    usage_model: row["usage_model"],
    billing_interval: row["billing_interval"],
    billing_interval_value: row["billing_interval_value"],
    price_type: row["price_type"],
    feature_type: row["feature_type"],
    soft_limit_enabled: row["soft_limit_enabled"],
    aggregation_method: row["aggregation_method"],
    carryover_enabled: row["carryover_enabled"],
  });

  return {
    agreement_id: subscriptionId,
    ...(featureKey === undefined ? {} : { feature_id: featureKey }),
    ...(rowId === undefined ? {} : { entitlement_row_id: rowId }),
    ...(value === undefined ? {} : { value }),
    limit_value: limitValue,
    ...(typeof row["active"] === "boolean" ? { is_enabled: row["active"] } : {}),
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
  };
}

// ---------------------------------------------------------------------------
// Billing (invoice summaries)
//
// The public API has no invoice-list endpoint and no invoice-line or payment
// read. The only invoice-shaped source is
// `GET /api/v1/subscriptions/{subscription_id}/billing-history`, keyed by a
// subscription the details payload has already named. So the handler fans out
// customers → details → subscriptions → billing history; see
// `billing-handler.ts` for the cost and the failure policy that fan-out forces.
//
// Billing history returns an unpaginated array, so there is no page loop here.
// Credit notes arrive as invoices with negative amounts and are kept: they are
// real documents, not errors.
// ---------------------------------------------------------------------------

/** The billing-history URL for one subscription. The id is a path segment. */
export function subscriptionBillingHistoryUrl(subscriptionId: string): string {
  return new URL(
    `${metrifoxApiBase().replace(/\/$/, "")}/api/v1/subscriptions/${encodeURIComponent(
      subscriptionId
    )}/billing-history`
  ).toString();
}

/**
 * Read one billing-history response.
 *
 * `undefined` is deliberately not an empty list. It means a 200 whose `data`
 * was not an array, an array with no record objects, or an array whose records
 * all lacked a non-empty `invoice_id` — each of which is a response we could
 * not interpret, and a changed key name must not masquerade as "no invoices".
 *
 * An empty array is usable and means exactly what it says: this subscription
 * has no invoices yet. A mixed array keeps the valid invoice rows and skips the
 * rest, so one malformed row does not discard a subscription's whole history.
 */
export function parseBillingHistory(
  json: unknown
): readonly RawRecord[] | undefined {
  const body = asRecord(json);
  const data = body?.["data"];
  if (!Array.isArray(data)) return undefined;
  if (data.length === 0) return [];

  const rows = recordsOf(data).filter(
    (row) => asString(row["invoice_id"]) !== undefined
  );
  return rows.length === 0 ? undefined : rows;
}

/**
 * Metrifox's invoice words, mapped onto our `INVOICE_STATUSES`.
 *
 * Three translations are judgement calls rather than one-to-one:
 *
 *   `pending` → `open` — the dashboard calls an issued, outstanding invoice
 *   Open; `pending` is the API's word for the same state, not a pre-issue
 *   draft.
 *
 *   `due`/`overdue` → `past_due` — both describe money that should already have
 *   arrived. Our enum has no `due` member, and leaving the status out would
 *   make a collectable invoice look statusless.
 *
 *   `written_off` → `uncollectible` — the amount is no longer expected. That is
 *   what our `uncollectible` means.
 *
 * `consolidated` and anything unrecognised return `undefined`, so no mapping
 * rule fires and the writer never sees a word it would warn about; the raw word
 * is still kept in `raw_status`.
 */
const METRIFOX_INVOICE_STATUS: Readonly<Record<string, string>> = {
  draft: "draft",
  open: "open",
  pending: "open",
  due: "past_due",
  overdue: "past_due",
  past_due: "past_due",
  paid: "paid",
  void: "void",
  voided: "void",
  uncollectible: "uncollectible",
  written_off: "uncollectible",
};

export function metrifoxInvoiceStatus(status: unknown): string | undefined {
  const word = normalizeWord(status);
  return word === undefined ? undefined : METRIFOX_INVOICE_STATUS[word];
}

/**
 * How many decimal places a currency has.
 *
 * `undefined` rather than Stigg's `2` fallback: the caller must leave the minor
 * amounts null when the currency is missing or `Intl` rejects it, because
 * defaulting to two decimals would invent a conversion for a currency we were
 * never told. The code is uppercased because Metrifox's examples are, but
 * `Intl` is case-insensitive anyway.
 */
function invoiceMinorUnitExponent(currency: string | undefined): number | undefined {
  const code = currency?.trim();
  if (code === undefined || code === "") return undefined;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code.toUpperCase(),
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return undefined;
  }
}

/**
 * A standard-units amount as minor units, or undefined when it cannot be
 * converted.
 *
 * Metrifox states amounts in standard units (`21`, `-23.0356`) while our
 * columns are integer minor units. The exponent is currency-specific — USD 2,
 * JPY 0, KWD 3 — so `21` is 2100 USD cents and `4900` is 4900 JPY. Rounding is
 * half away from zero so a credit note stays negative (`-23.0356` → `-2304`),
 * and `-0` is normalized to `0` because the column is an integer, not a sign.
 *
 * The value is accepted as a number or a numeric string: the docs type
 * `total_amount` as a number, but real payloads sometimes stringify decimals.
 */
export function metrifoxMinorAmount(
  value: unknown,
  currency: string | undefined
): number | undefined {
  const stated = numericString(value);
  if (stated === undefined) return undefined;

  const exponent = invoiceMinorUnitExponent(currency);
  if (exponent === undefined) return undefined;

  const scaled = Number(stated) * 10 ** exponent;
  if (!Number.isFinite(scaled)) return undefined;

  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * An amount exactly as the payload stated it: a finite number or a numeric
 * string.
 *
 * Used only for `provider_metadata`. The raw figure must survive verbatim so a
 * fractional major amount that had to be rounded into the integer column is
 * still auditable.
 */
function statedAmount(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return numericString(value);
}

/**
 * The synthesized fields for one invoice summary.
 *
 * `customer_id` is the customers-list `id` identity already keys on, and
 * `agreement_id` is the subscription whose billing history returned the row.
 * Both are injected by the handler because the payload states neither in a form
 * that resolves.
 *
 * `status` is always written — explicitly `undefined` when unrecognised — for
 * the same reason the agreement flattener documents: the caller spreads the raw
 * record first, so a bare omission would let Metrifox's own word reach the enum
 * validator. `raw_status` keeps that word.
 *
 * `issued_at` is synthesized from `issued_date` and is deliberately withheld
 * for a draft: `Invoice.issuedAt` is documented as null on a draft, and
 * Metrifox's example draft carries a future `issued_date`. The handler ignores
 * drafts before flattening, so this rule is the second line of defence for a
 * direct caller; the raw `issued_date` stays on the record and in metadata for
 * custom mappings.
 *
 * Deliberately absent: subtotal, discount, tax, paid date, service period and
 * hosted URL. Metrifox states none of them, and a total is never computed from
 * anything — it is the provider's own figure.
 */
export function flattenMetrifoxInvoice(
  invoice: RawRecord,
  customerId: string,
  subscriptionId: string
): RawRecord {
  const status = metrifoxInvoiceStatus(invoice["status"]);
  const rawStatus = asString(invoice["status"]);
  const currency = asString(invoice["currency"]);

  const totalMinor = metrifoxMinorAmount(invoice["total_amount"], currency);
  const amountPaidMinor = metrifoxMinorAmount(invoice["amount_paid"], currency);
  const balanceDueMinor = metrifoxMinorAmount(invoice["balance_due"], currency);

  const providerMetadata = metrifoxJson({
    subscription_id: subscriptionId,
    raw_status: rawStatus,
    source_type: asString(invoice["source_type"]),
    payment_method: asString(invoice["payment_method"]),
    created_at: asString(invoice["created_at"]),
    issued_date: asString(invoice["issued_date"]),
    total_amount: statedAmount(invoice["total_amount"]),
    amount_paid: statedAmount(invoice["amount_paid"]),
    balance_due: statedAmount(invoice["balance_due"]),
  });

  return {
    // Raw first, so the synthesized keys below win where names collide.
    ...invoice,
    customer_id: customerId,
    agreement_id: subscriptionId,
    // Always present, even as `undefined`. See the doc comment.
    status,
    ...(rawStatus === undefined ? {} : { raw_status: rawStatus }),
    ...(totalMinor === undefined ? {} : { total_amount_minor: totalMinor }),
    ...(amountPaidMinor === undefined
      ? {}
      : { amount_paid_minor: amountPaidMinor }),
    ...(balanceDueMinor === undefined
      ? {}
      : { balance_due_minor: balanceDueMinor }),
    // Always written, so a raw `issued_at` cannot survive a draft. The key is
    // present with `undefined`, which the mapper reads as "not stated".
    issued_at: status === "draft" ? undefined : asString(invoice["issued_date"]),
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
  };
}
