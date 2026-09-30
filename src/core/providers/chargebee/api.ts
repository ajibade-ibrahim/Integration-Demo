/**
 * Chargebee REST API helpers: URL builders, authentication header parsing,
 * cursor pagination, and contact synthesis.
 *
 * Docs: https://apidocs.chargebee.com/v2/#customers
 */

import type { RawRecord } from "../../types/common";
import { asArray, asRecord, asString } from "../http";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const CHARGEBEE_MAX_PAGES = 1000;

export function chargebeePageSize(): number {
  const raw = process.env["CHARGEBEE_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Parse a full `site:api_key` string or raw API key into site and key components.
 */
export function parseChargebeeCredential(credential: string): {
  site: string | undefined;
  apiKey: string;
} {
  const trimmed = credential.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    return {
      site: trimmed.slice(0, colonIndex).trim(),
      apiKey: trimmed.slice(colonIndex + 1).trim(),
    };
  }
  return {
    site: undefined,
    apiKey: trimmed,
  };
}

/**
 * Chargebee uses Basic HTTP Authentication with the API key as the username
 * and an empty password: `Authorization: Basic <base64(apiKey + ":")>`.
 */
export function chargebeeAuthHeaders(credential: string): Record<string, string> {
  const { apiKey } = parseChargebeeCredential(credential);
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
  };
}

/**
 * Base URL for the Chargebee API.
 *
 * Overridable via `CHARGEBEE_API_BASE` for local dev/test mocks.
 * Defaults to `https://{site}.chargebee.com`.
 */
export function chargebeeApiBase(site: string): string {
  const envBase = process.env["CHARGEBEE_API_BASE"];
  const resolved =
    envBase !== undefined && envBase !== ""
      ? envBase
      : `https://${site}.chargebee.com`;

  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(
      `CHARGEBEE_API_BASE must use https (or localhost); got '${resolved}'`
    );
  }
  return resolved;
}

export function customersUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/customers`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export interface ChargebeeCustomersPage {
  readonly records: readonly RawRecord[];
  readonly nextOffset: string | undefined;
}

/**
 * Parse a Chargebee customer list response envelope:
 * `{ list: [ { customer: { ... } } ], next_offset: "..." }`
 */
export function parseCustomersPage(json: unknown): ChargebeeCustomersPage {
  const body = asRecord(json);
  const list = asArray(body?.["list"]);

  const records: RawRecord[] = [];
  for (const item of list) {
    const customer = asRecord(asRecord(item)?.["customer"]);
    if (customer !== undefined) {
      records.push(customer);
    }
  }

  const nextOffset = asString(body?.["next_offset"]);

  return {
    records,
    nextOffset: nextOffset === "" ? undefined : nextOffset,
  };
}

/**
 * Chargebee's `created_at` (Unix epoch seconds) to ISO string.
 */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Synthetic contact ID for Chargebee customer.
 */
export function chargebeeContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing contact record for a Chargebee customer.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const firstName = asString(customer["first_name"])?.trim();
  const lastName = asString(customer["last_name"])?.trim();

  const billing = asRecord(customer["billing_address"]);
  const billingFirstName = asString(billing?.["first_name"])?.trim();
  const billingLastName = asString(billing?.["last_name"])?.trim();

  let nameParts = [firstName, lastName].filter(
    (part): part is string => part !== undefined && part !== ""
  );
  if (nameParts.length === 0) {
    nameParts = [billingFirstName, billingLastName].filter(
      (part): part is string => part !== undefined && part !== ""
    );
  }

  const company = asString(customer["company"])?.trim();

  const email =
    asString(customer["email"])?.trim() ??
    asString(billing?.["email"])?.trim();

  const phone =
    asString(customer["phone"])?.trim() ??
    asString(billing?.["phone"])?.trim();

  const contactName =
    nameParts.length > 0
      ? nameParts.join(" ")
      : email !== undefined
      ? localPart(email)
      : company;

  if (contactName === undefined || contactName === "") return undefined;

  return {
    contact_id: chargebeeContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    phone: phone ?? null,
    customer_id: customerId,
    customer_name: company ?? contactName,
  };
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// ---------------------------------------------------------------------------
// Catalog V2 (Item Families, Items, Item Prices)
// ---------------------------------------------------------------------------

export function itemFamiliesUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/item_families`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function itemsUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/items`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function itemPricesUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/item_prices`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export interface ChargebeeListPage {
  readonly records: readonly RawRecord[];
  readonly nextOffset: string | undefined;
}

export function parseEnvelopePage(
  json: unknown,
  entityKey: string
): ChargebeeListPage {
  const body = asRecord(json);
  const list = asArray(body?.["list"]);

  const records: RawRecord[] = [];
  for (const item of list) {
    const record = asRecord(asRecord(item)?.[entityKey]);
    if (record !== undefined) {
      records.push(record);
    }
  }

  const nextOffset = asString(body?.["next_offset"]);

  return {
    records,
    nextOffset: nextOffset === "" ? undefined : nextOffset,
  };
}

export function parseItemFamiliesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_family");
}

export function parseItemsPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item");
}

export function parseItemPricesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_price");
}

// ---------------------------------------------------------------------------
// Entitlements (Features, Item Entitlements)
// ---------------------------------------------------------------------------

/**
 * The site's feature *definitions*.
 *
 * Read for their ids only: each one is the parent segment of a
 * `featureItemEntitlementsUrl` request. Also the cheap "does this site use
 * Entitlements at all?" answer — a site with no features yields an empty first
 * page and the per-feature pass never starts.
 */
export function featuresUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/features`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

/**
 * The items one feature is attached to.
 *
 * Per feature because Chargebee has no site-wide item-entitlement list
 * (`/api/v2/item_entitlements` is a 404). Per feature rather than per item
 * because a catalog usually defines fewer features than items, so this is the
 * shorter fan-out of the two.
 *
 * The id is percent-encoded: it is a path segment built from response data.
 */
export function featureItemEntitlementsUrl(
  site: string,
  featureId: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(
    `${base}/api/v2/features/${encodeURIComponent(featureId)}/item_entitlements`
  );
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function parseFeaturesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "feature");
}

/**
 * Item entitlements, passed through as they arrive.
 *
 * No flattening is needed, unlike Stripe's attachment: Chargebee puts
 * `feature_id`, `feature_name` and the parent `item_id` at the top level of
 * every record, so the offering link is read from the payload itself.
 */
export function parseItemEntitlementsPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_entitlement");
}

export function flattenItemPrice(itemPrice: RawRecord): RawRecord {
  const periodUnit = asString(itemPrice["period_unit"])?.toLowerCase();
  const period = itemPrice["period"];

  let interval: string = "one_time";
  if (periodUnit === "day" || periodUnit === "week" || periodUnit === "month" || periodUnit === "year") {
    interval = periodUnit;
  }

  const name = asString(itemPrice["name"]) ?? asString(itemPrice["id"]) ?? "Price";
  const createdAt = epochToIso(itemPrice["created_at"]);

  return {
    price_name: name,
    offering_id: asString(itemPrice["item_id"]),
    interval,
    interval_count: typeof period === "number" ? period : 1,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  };
}

// ---------------------------------------------------------------------------
// Subscriptions (agreements)
//
// Unlike Stripe, Chargebee inlines a subscription's `subscription_items` in the
// list payload, so lines need no per-subscription request. Entitlements do:
// `/subscriptions/{id}/subscription_entitlements` is the per-subscription
// fan-out, and that is the only request this section adds beyond the list.
//
// Both list envelopes are nested one level under the singular object name —
// `list: [{ subscription: {…} }]` — which is why every parser goes through
// `parseEnvelopePage` and reads the inner key rather than the list element.
// ---------------------------------------------------------------------------

export function subscriptionsUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/subscriptions`);
  url.searchParams.set("limit", String(limit));
  // Discounts are only inlined when asked for. Without this the `discounts` key
  // is absent from every record, which the handler would read as "this
  // subscription has no discounts" and withhold completeness for — silently
  // disabling discount reconciliation forever. Asking for them is the
  // difference between an empty list and a missing one.
  url.searchParams.set("include_discounts", "true");
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

/**
 * The *effective* entitlement list for one subscription.
 *
 * Returns inherited and overridden values folded together, so a row here can
 * restate an `Entitlement` from the catalog and add a per-subscription
 * override the catalog never sees. That overlap is the point and is why the two
 * tables must never be summed.
 *
 * The id is percent-encoded: it is a path segment built from response data.
 */
export function subscriptionEntitlementsUrl(
  site: string,
  subscriptionId: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(
    `${base}/api/v2/subscriptions/${encodeURIComponent(subscriptionId)}/subscription_entitlements`
  );
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function parseSubscriptionsPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "subscription");
}

export function parseSubscriptionEntitlementsPage(
  json: unknown
): ChargebeeListPage {
  return parseEnvelopePage(json, "subscription_entitlement");
}

/**
 * A subscription's inline lines.
 *
 * Each element is a flat `subscription_item` object — `item_price_id`,
 * `item_type`, `quantity`, `unit_price`, `free_quantity`, `billing_cycles` —
 * not a wrapper nested under `subscription_item`, which is why this reads the
 * array elements directly rather than unwrapping a key. The array is optional,
 * so the caller must also ask whether the key was present at all before
 * treating an empty result as "no lines".
 */
export function subscriptionItems(
  subscription: RawRecord
): readonly RawRecord[] {
  return asArray(subscription["subscription_items"]).filter(
    (row): row is RawRecord => asRecord(row) !== undefined
  );
}

/**
 * Whether a subscription payload carried the `subscription_items` key.
 *
 * Distinct from `subscriptionItems(...).length > 0`, deliberately: an absent
 * key and an empty array are different facts, and only the first withholds the
 * item list's completeness. See `chargebeeAgreementHandler`.
 */
export function hasSubscriptionItemsKey(subscription: RawRecord): boolean {
  return subscription["subscription_items"] !== undefined;
}

export function hasDiscountsKey(subscription: RawRecord): boolean {
  return subscription["discounts"] !== undefined;
}

/** Chargebee's subscriptions' own status words, mapped to ours. */
const CHARGEBEE_SUBSCRIPTION_STATUS: Record<string, string> = {
  // Agreed but not started. Maps to `scheduled`, not `draft`: `draft` means
  // never agreed, which is what Stripe's `incomplete` maps to.
  future: "scheduled",
  in_trial: "trialing",
  active: "active",
  // Will cancel at term end. Our vocabulary treats that as a flag on an active
  // subscription (`cancelAtPeriodEnd`), not a lifecycle state of its own.
  non_renewing: "active",
  paused: "paused",
  cancelled: "canceled",
  // A business-entity bookkeeping state, not lifecycle: the subscription is
  // still in service, so it reads as active. Chargebee's own word is kept in
  // `customFields.chargebee_status`, the escape hatch Stripe's `raw_status` is.
  transferred: "active",
};

export function chargebeeAgreementStatusOf(
  subscription: RawRecord
): string | undefined {
  const raw = asString(subscription["status"]);
  return raw === undefined ? undefined : CHARGEBEE_SUBSCRIPTION_STATUS[raw];
}

/**
 * Our collection method, from Chargebee's `auto_collection` on/off.
 *
 * `off` is `manual`, not `none`: Chargebee still raises invoices, they are just
 * not auto-collected. `none` has no Chargebee spelling.
 */
export function chargebeeCollectionMethodOf(
  subscription: RawRecord
): string | undefined {
  switch (asString(subscription["auto_collection"])) {
    case "on":
      return "automatic";
    case "off":
      return "manual";
    default:
      return undefined;
  }
}

/** A subscription's own cadence unit, validated against our four. */
export function chargebeeBillingPeriodOf(
  subscription: RawRecord
): string | undefined {
  const unit = asString(subscription["billing_period_unit"])?.toLowerCase();
  return unit === "day" || unit === "week" || unit === "month" || unit === "year"
    ? unit
    : undefined;
}

/**
 * Chargebee's `meta_data` bag, serialized for a `providerMetadata` column.
 * Flat by contract, as Stripe's is; absent returns undefined so no rule fires.
 */
export function chargebeeProviderMetadataOf(
  record: RawRecord
): string | undefined {
  const metadata = asRecord(record["meta_data"]);
  return metadata === undefined ? undefined : JSON.stringify(metadata);
}

/**
 * A name for the agreement.
 *
 * Chargebee subscriptions have no name and the list payload does not inline the
 * item price object, so the best available label is the plan line's
 * `item_price_id`. A nicer label — the item price's `name` — needs the
 * item-price object, which is one request per subscription and deliberately
 * not paid here. Falling back to the subscription id keeps the required
 * `Agreement.name` non-empty for a subscription with no `plan` line, which is
 * a malformed subscription rather than an ordinary one.
 */
export function chargebeeAgreementNameOf(subscription: RawRecord): string {
  const plan = subscriptionItems(subscription).find(
    (item) => asString(item["item_type"]) === "plan"
  );
  const priceId = plan === undefined ? undefined : asString(plan["item_price_id"]);
  return priceId ?? asString(subscription["id"]) ?? "Subscription";
}

/**
 * The synthesized fields for one Chargebee subscription.
 *
 * `agreement_name`, `agreement_type` and `status` mirror the Stripe shapes for
 * the same reasons: no provider name, a known discriminator, and a status in
 * our vocabulary rather than the provider's. `ended_at` is written *only* for a
 * cancelled subscription and from `cancelled_at`, because Chargebee does not
 * distinguish "cancellation requested" from "ended" — the asymmetry against
 * Stripe's distinct `ended_at` is deliberate and documented on the column's
 * consumer.
 *
 * `entitlements_disabled` is set by the handler when the Entitlements feature
 * is off on the site, so the withholding is visible on the agreement rather
 * than silent.
 */
export function flattenChargebeeSubscription(
  subscription: RawRecord,
  extraMetadata?: Record<string, string>
): RawRecord {
  const status = chargebeeAgreementStatusOf(subscription);
  const rawStatus = asString(subscription["status"]);
  const collectionMethod = chargebeeCollectionMethodOf(subscription);
  const billingPeriod = chargebeeBillingPeriodOf(subscription);
  const billingPeriodCount = subscription["billing_period"];
  const metadata = {
    ...(asRecord(subscription["meta_data"]) === undefined
      ? {}
      : (asRecord(subscription["meta_data"]) as Record<string, string>)),
    ...(extraMetadata ?? {}),
  };

  // `non_renewing` is the only Chargebee word that means "will not renew" —
  // there is no separate boolean — so it is where the flag comes from.
  const cancelAtPeriodEnd = rawStatus === "non_renewing" ? "true" : undefined;

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["current_period_start", "current_term_start"],
    ["current_period_end", "current_term_end"],
    ["effective_date", "started_at"],
    ["trial_starts_at", "trial_start"],
    ["trial_ends_at", "trial_end"],
    ["canceled_at", "cancelled_at"],
    ["cancel_at", "cancel_at"],
    ["next_billing_at", "next_billing_at"],
  ] as const) {
    const iso = epochToIso(subscription[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }

  // `Agreement.endDate`. Only a cancelled subscription has an end, and
  // Chargebee states it with the same field it uses for the request date, so
  // there is no "ended but not cancelled" case to distinguish here.
  if (rawStatus === "cancelled") {
    const ended = epochToIso(subscription["cancelled_at"]);
    if (ended !== undefined) dates["ended_at"] = ended;
  }

  return {
    agreement_name: chargebeeAgreementNameOf(subscription),
    agreement_type: "subscription",
    ...(status === undefined ? {} : { status }),
    ...(rawStatus === undefined ? {} : { chargebee_status: rawStatus }),
    customer_id: asString(subscription["customer_id"]),
    ...(collectionMethod === undefined
      ? {}
      : { collection_method: collectionMethod }),
    ...(billingPeriod === undefined ? {} : { billing_period: billingPeriod }),
    ...(typeof billingPeriodCount === "number"
      ? { billing_period_count: billingPeriodCount }
      : {}),
    ...(cancelAtPeriodEnd === undefined
      ? {}
      : { cancel_at_period_end: cancelAtPeriodEnd }),
    item_count: subscriptionItems(subscription).length,
    ...(Object.keys(metadata).length === 0
      ? {}
      : { provider_metadata: JSON.stringify(metadata) }),
    ...dates,
  };
}

/**
 * Our line type, from Chargebee's three words.
 *
 * Chargebee types its lines first-class, and `addon` is the one translation
 * needed — our union spells it `add_on`. An unrecognised type returns
 * `undefined`, which the mapping rule omits and the writer leaves null.
 */
export function chargebeeItemTypeOf(item: RawRecord): string | undefined {
  switch (asString(item["item_type"])) {
    case "plan":
      return "plan";
    case "addon":
      return "add_on";
    case "charge":
      return "charge";
    default:
      return undefined;
  }
}

/**
 * The synthesized fields for one inline subscription item.
 *
 * Only two: `agreement_id` is injected by the caller from the subscription it
 * was read from — the payload's own `subscription_id` is deliberately ignored,
 * as `flattenAgreementItem` ignores Stripe's `subscription` — and `item_type`
 * is translated. `price_id` is the raw `item_price_id`; `offering_id` stays
 * absent because the item price's product is not in the list payload, so
 * `AgreementItem.offeringId` stays null and `externalPriceId` keeps the id.
 *
 * `billing_model` is deliberately not synthesized: Chargebee states metering as
 * `pricing_model` on the *item price*, which this payload does not inline. The
 * follow-up is `Price.pricingModel` on the catalog function; faking it here
 * would put a wrong value behind a right column.
 */
export function flattenChargebeeSubscriptionItem(
  item: RawRecord,
  subscriptionId: string,
  position: number
): RawRecord {
  const itemType = chargebeeItemTypeOf(item);
  return {
    agreement_id: subscriptionId,
    price_id: asString(item["item_price_id"]),
    position,
    ...(itemType === undefined ? {} : { item_type: itemType }),
  };
}

/**
 * The synthesized fields for one subscription entitlement.
 *
 * One only: the agreement, injected from the subscription fetched. The payload
 * does carry its own `subscription_id`, and it is ignored for
 * `flattenAgreementItem`'s reason — this is a writer that deletes, so a row
 * must not be able to name a different parent.
 */
export function flattenChargebeeSubscriptionEntitlement(
  subscriptionId: string
): RawRecord {
  return { agreement_id: subscriptionId };
}

/** Our discount kind, from Chargebee's `type`. */
function chargebeeDiscountKindOf(discount: RawRecord): string | undefined {
  switch (asString(discount["type"])) {
    case "percentage":
      return "percentage";
    case "fixed_amount":
      return "fixed_amount";
    case "offer_quantity":
      return "free_items";
    default:
      return undefined;
  }
}

/**
 * Our discount status, derived from Chargebee's `duration_type`.
 *
 * Chargebee's list returns only discounts *currently attached* to a
 * subscription — a `one_time` discount is dropped after it is applied, and a
 * `limited_period` one after it expires — so a listed discount is by
 * definition active, and its `duration_type` describes how long it will stay
 * attached rather than where it stands. The three values therefore all land on
 * `active`; the alternatives (`expired`, `removed`) describe rows Chargebee
 * never sends, and reconciliation deletes a discount the moment it drops off
 * the list. Documented rather than silently collapsed.
 */
function chargebeeDiscountStatusOf(discount: RawRecord): string | undefined {
  switch (asString(discount["duration_type"])) {
    case "one_time":
    case "forever":
    case "limited_period":
      return "active";
    default:
      return undefined;
  }
}

/**
 * One discount attached to a subscription, flattened for mapping.
 *
 * Chargebee's discount object is flat, so this passes most fields through under
 * the names our default rules expect and synthesizes only `agreement_id`.
 * `endsAt` reads `apply_till`, the field Chargebee sends for the end of a
 * `limited_period` discount; it is absent for the other two duration types.
 */
export function flattenChargebeeDiscount(
  discount: RawRecord,
  subscriptionId: string
): RawRecord {
  const kind = chargebeeDiscountKindOf(discount);
  const status = chargebeeDiscountStatusOf(discount);
  const startsAt = epochToIso(discount["created_at"]);
  const endsAt = epochToIso(discount["apply_till"]);

  return {
    ...discount,
    agreement_id: subscriptionId,
    discount_id: asString(discount["id"]),
    ...(kind === undefined ? {} : { discount_kind: kind }),
    ...(status === undefined ? {} : { discount_status: status }),
    ...(startsAt === undefined ? {} : { starts_at: startsAt }),
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
  };
}

/** A subscription's inline discounts, tolerating an absent or malformed list. */
export function subscriptionDiscounts(
  subscription: RawRecord
): readonly RawRecord[] {
  return asArray(subscription["discounts"]).filter(
    (row): row is RawRecord => asRecord(row) !== undefined
  );
}
