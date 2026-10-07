/**
 * Stripe REST specifics: base URL, API version, cursor pagination, and the
 * synthesis of a billing contact from the customer's own fields.
 *
 * Two shapes here are Stripe-specific and carry the risk:
 *
 *   1. Pagination is a cursor built from *our own* returned data
 *      (`starting_after=<id of the last row>`), not an opaque token the server
 *      hands back. So the terminating condition depends on us reading an id
 *      correctly — see `parseCustomersPage`.
 *   2. `created` is Unix epoch seconds, and every date the record writer
 *      accepts goes through `new Date(string)`. `epochToIso` exists so a
 *      mapped create date is not silently dropped.
 *
 * Docs: https://docs.stripe.com/api/customers/list
 */

import type { RawRecord } from "../../types/common";
import { formatInterval, priceLabel } from "../../price-format";
import { asArray, asRecord, asString } from "../http";

/** Records per page. Stripe's own default is 10; its documented maximum is 100. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Runaway guard.
 *
 * Metrifox needs one because page numbers have no natural end. Stripe's cursor
 * does terminate — but only when the server says `has_more: false`, and the
 * cursor itself is derived from ids we read out of the response. A server
 * emitting fresh ids with `has_more: true` forever would page until the process
 * died, so the bound is on us rather than on its good behaviour.
 */
export const STRIPE_MAX_PAGES = 1000;

/** How many customers discovery samples to find tenant-specific metadata keys. */
export const STRIPE_DISCOVERY_SAMPLE = 25;

/**
 * The API version this provider is written against.
 *
 * Pinned, and pinned overridably, for the same reason as
 * `salesforceApiVersion()`: the response shape this file parses belongs to a
 * version, and letting it follow the *account's* default version means a
 * dashboard setting on someone else's Stripe account decides what our parser
 * receives. Env-overridable is load-bearing in the other direction too — Stripe
 * answers an unrecognised version with a 400, which `createProviderSession`
 * classifies as fatal, so a stale literal here would be an unfixable failed run.
 */
export function stripeApiVersion(): string {
  const version = process.env["STRIPE_API_VERSION"];
  return version === undefined || version === "" ? "2026-08-26.dahlia" : version;
}

/**
 * Base URL for the Stripe API.
 *
 * Overridable so tests and a local `stripe-mock` can point elsewhere, exactly
 * like `metrifoxApiBase()`.
 */
export function stripeApiBase(): string {
  const base = process.env["STRIPE_API_BASE"];
  const resolved = base === undefined || base === "" ? "https://api.stripe.com" : base;

  // The API key travels in a header on every one of these requests. A base that
  // is neither HTTPS nor loopback would put a live credential on the wire in
  // clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(`STRIPE_API_BASE must use https (or localhost); got '${resolved}'`);
  }
  return resolved;
}

export function stripePageSize(): number {
  const raw = process.env["STRIPE_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Headers carrying the credential and the pinned API version.
 *
 * One function rather than two so the connect-time probe and the sync session
 * cannot drift onto different API versions — the probe deliberately bypasses
 * `createProviderSession`, so without this it would be the one request in the
 * system speaking an unpinned version.
 *
 * `Stripe-Version` rides along here because `ProviderSessionOptions` offers no
 * other header hook. Adding a `staticHeaders` option to the shared client for
 * one provider's benefit would be the wrong trade: this is a two-line comment,
 * that would be a new concept in a file every provider depends on.
 */
export function stripeAuthHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": stripeApiVersion(),
  };
}

/**
 * The Stripe list resources this provider reads.
 *
 * A union rather than a bare string so a typo cannot reach the wire as a 404,
 * and so adding a resource is a decision recorded here rather than a literal
 * buried in a handler.
 */
export const STRIPE_RESOURCES = [
  "customers",
  "products",
  "prices",
  "subscriptions",
  "invoices",
  "charges",
  "refunds",
  "invoice_payments",
] as const;

export type StripeResource = (typeof STRIPE_RESOURCES)[number];

/**
 * A paginated Stripe URL for any path, with the cursor parameters applied.
 *
 * Private, and the sole implementation of Stripe's pagination convention. It
 * exists because `/v1/products/{id}/features` is not a top-level list resource
 * and so cannot go through `listUrl`, while sharing every rule with it — same
 * `limit`, same `starting_after`, same refusal to let a caller's filter clobber
 * either.
 */
function paginatedUrl(
  path: string,
  limit: number,
  startingAfter?: string,
  extra?: Readonly<Record<string, string>>
): string {
  // Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
  // base's own path entirely, which would silently strip any prefix a mock or
  // proxy is mounted under.
  const url = new URL(`${stripeApiBase().replace(/\/$/, "")}${path}`);
  url.searchParams.set("limit", String(limit));
  if (startingAfter !== undefined) {
    url.searchParams.set("starting_after", startingAfter);
  }
  // Set after the pagination parameters but never able to overwrite them: a
  // resource filter that could clobber `starting_after` would page forever.
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key === "limit" || key === "starting_after") continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * A `/v1/<resource>` list URL with Stripe's cursor pagination applied.
 *
 * One builder for every resource, because Stripe's list endpoints are uniform:
 * same `limit`, same `starting_after`, same envelope. Three near-identical URL
 * builders would be three places for the cursor parameter to be misspelled.
 *
 * Still takes a `StripeResource` rather than a path, which is the whole point of
 * keeping it as a wrapper: a typo cannot reach the wire as a 404.
 */
export function listUrl(
  resource: StripeResource,
  limit: number,
  startingAfter?: string,
  extra?: Readonly<Record<string, string>>
): string {
  return paginatedUrl(`/v1/${resource}`, limit, startingAfter, extra);
}

/**
 * The features attached to one product.
 *
 * A per-product sub-resource rather than a filter on a list, which is why this
 * cannot be a `listUrl` call: there is no `/v1/product_features?product=…`, and
 * `?expand[]=features` on the product itself answers "This property cannot be
 * expanded (features)". Reading features therefore costs one paginated request
 * per product, and `accountUsesEntitlements` in the catalog handler exists to
 * avoid paying it for the accounts that would learn nothing.
 *
 * The id is percent-encoded. Belt and braces for Stripe's own ids, which are
 * alphanumeric — and load-bearing for anything a mock, proxy or fixture returns,
 * because this is the first path segment in the system built from data rather
 * than from a literal.
 */
export function productFeaturesUrl(
  productId: string,
  limit: number,
  startingAfter?: string
): string {
  return paginatedUrl(
    `/v1/products/${encodeURIComponent(productId)}/features`,
    limit,
    startingAfter
  );
}

/**
 * The account's feature *definitions* — one page, used to ask whether there are
 * any, and by discovery to sample their metadata keys.
 *
 * This is the cheap answer to an expensive question. The per-product fan-out
 * below costs one request per product to discover nothing at all on every
 * account that does not use Entitlements, which is most of them. This endpoint
 * is flat and listable, so a single request with `limit=1` settles it.
 *
 * The definitions themselves are synced, but *not* from here: the sync reads
 * each attachment's nested `entitlement_feature` on the per-product call it was
 * already making, so a definition attached to no product is not synced at all.
 * See `flattenFeatureDefinition`.
 */
export function entitlementFeaturesUrl(limit: number): string {
  return paginatedUrl("/v1/entitlements/features", limit);
}

/**
 * The items on one subscription, as a filtered top-level list.
 *
 * Unlike `productFeaturesUrl` this is a real list endpoint with the parent as a
 * query parameter, so the subscription id needs none of that builder's path
 * encoding — `URLSearchParams` escapes it, and `paginatedUrl` already refuses
 * to let `extra` clobber the cursor.
 *
 * Only reached when a subscription carries more items than Stripe inlines.
 * `subscription.items.data` holds the first ten and sets `has_more` beyond
 * that, so the common case costs nothing and a large subscription costs one
 * request per extra page. Skipping this and trusting the inline list is the
 * bug that would let the writer delete a subscription's eleventh line onwards
 * on every sync — see the completeness obligation on `SyncHandler`.
 */
export function subscriptionItemsUrl(
  subscriptionId: string,
  limit: number,
  startingAfter?: string
): string {
  return paginatedUrl("/v1/subscription_items", limit, startingAfter, {
    subscription: subscriptionId,
  });
}

/** Back-compat alias for the customers list, which several call sites name. */
export function customersUrl(limit: number, startingAfter?: string): string {
  return listUrl("customers", limit, startingAfter);
}

export interface StripePage {
  readonly records: readonly RawRecord[];
  /** Stripe's own end-of-data signal. */
  readonly hasMore: boolean;
  /**
   * Cursor for the next request: the id of the last usable row on this page,
   * or undefined if this page yielded none. Undefined has to stop the loop even
   * when `hasMore` is true — the alternative is repeating the previous cursor
   * forever.
   */
  readonly lastId: string | undefined;
}

/**
 * Read one list response.
 *
 * Resource-agnostic, and always was — every Stripe list endpoint returns the
 * same `{ object, data, has_more }` envelope, so products and prices page
 * through exactly this parser rather than copies of it.
 *
 * `object === "list"` is deliberately not required. It is present on every real
 * response, but treating it as a gate means a fixture or proxy that omits it
 * yields zero records and a clean, silent, empty sync — a much worse failure
 * than a parse error. `data` and `has_more` are the only fields that matter.
 */
export function parseListPage(json: unknown): StripePage {
  const body = asRecord(json);
  const data = asArray(body?.["data"]);

  const records = data.filter((row): row is RawRecord => asRecord(row) !== undefined);

  // Scanned backwards, because the cursor must be the last row Stripe returned,
  // not the last one we happened to find an id on.
  let lastId: string | undefined;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const id = asString(records[i]?.["id"]);
    if (id !== undefined) {
      lastId = id;
      break;
    }
  }

  return {
    records,
    // Strict, because `Boolean("false")` is true and providers do send strings.
    hasMore: body?.["has_more"] === true,
    lastId,
  };
}

/** Back-compat alias, for call sites that only ever read customers. */
export const parseCustomersPage = parseListPage;

// ---------------------------------------------------------------------------
// Synthesized fields
// ---------------------------------------------------------------------------

/**
 * Stripe's `created` (Unix epoch seconds) as an ISO 8601 string.
 *
 * Without this, mapping `created` to `customer.createDate` loses the value
 * silently: the field mapper stringifies the number to "1680893993", and the
 * record writer's date parse is `new Date(value)`, which is an Invalid Date for
 * that input and stores null. No transform rescues it either — `dateOnly`
 * returns its input unchanged when parsing fails. So the conversion has to
 * happen while we still have the number.
 *
 * Takes `unknown` and narrows locally: `asString` returns undefined for a
 * number, and there is no `asNumber` in the shared helpers — adding one for a
 * single caller would widen a file every provider imports.
 */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The stable synthetic id for a customer's billing contact.
 *
 * ALGORITHM v1 — changing this re-keys every existing Stripe contact. `Contact`
 * is unique on `(integrationId, externalSourceId)`, so an id that shifts
 * between runs does not error: it silently inserts a duplicate person and
 * orphans the old row.
 *
 * A *constant* slot, unlike Metrifox's email-derived one. That difference is
 * the point: Metrifox lists several contact people per customer and needs to
 * tell them apart, while Stripe has exactly one contact per customer by
 * construction. Deriving the id from the email here would buy nothing and cost
 * everything — an address correction would re-key the row.
 */
export function stripeContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing-contact record for one Stripe customer.
 *
 * Deliberately not a spread of the customer. Two reasons: `externalIdOf` falls
 * back to `id` for customers, so a contact carrying the customer's `id` would
 * make that fallback ambiguous; and `STRIPE_CONTACT_FIELDS` is a static list,
 * so a spread would put `metadata.*` and every other customer field onto
 * contact records that the mapping editor never offers.
 *
 * @returns The record, or undefined when there is nothing identifying to build
 *   it from. That guard is not cosmetic: `Contact.name` is required, and the
 *   record writer trims before checking, so a customer whose name is blank or
 *   whitespace and whose email is absent would be rejected for "Name is
 *   required" on every sync, forever. Emitting nothing is the honest answer —
 *   Stripe simply has no contact for that customer.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const name = nonEmpty(asString(customer["name"])?.trim());
  const email = nonEmpty(asString(customer["email"])?.trim());

  // Stripe's `name` is whatever the merchant put there — a person for a
  // consumer business, a company for a B2B one. Either way it is the name
  // attached to this billing relationship, so it is the best contact name
  // available. The email local part is the fallback, which is at least
  // recognisable to whoever set the address.
  const contactName = name ?? (email === undefined ? undefined : localPart(email));
  if (contactName === undefined) return undefined;

  return {
    contact_id: stripeContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    phone: asString(customer["phone"])?.trim() ?? null,
    customer_id: customerId,
    customer_name: name ?? null,
  };
}

/** Collapse a blank string to undefined, so "  " and absent behave alike. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  // `at > 0`, not `!== -1`: an address that begins with "@" has no local part,
  // and slicing it would produce the empty name this whole guard exists to
  // avoid.
  return at > 0 ? email.slice(0, at) : email;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * A display name for a price.
 *
 * Stripe's `nickname` is optional and in practice usually null, while
 * `Offering.name` is required — so without this every unnamed price would be
 * rejected for "Name is required" on every sync, forever. Same class of problem
 * as `synthesizeContact`'s name fallback, and the same answer: build the best
 * name available while we still have the parts, because no downstream transform
 * can reconstruct it.
 *
 * Four layers, each a genuine case rather than defensive padding:
 *   1. the merchant's own nickname, if they set one;
 *   2. the amount and its recurrence — "$49/month", the thing a person would
 *      say. Built by the shared `priceLabel` so this name and the price column
 *      on /catalog cannot disagree about the same offering;
 *   3. "Custom pricing/month" for tiered and metered prices, which carry no
 *      `unit_amount` at all. The recurrence is still known, and saying it is
 *      better than a bare "Custom pricing" on every one of them;
 *   4. the price id, which always exists, so the result is never empty.
 */
export function offeringDisplayName(price: RawRecord): string {
  const nickname = asString(price["nickname"])?.trim();
  if (nickname !== undefined && nickname !== "") return nickname;

  const recurring = asRecord(price["recurring"]);
  const interval = asString(recurring?.["interval"]);
  const countRaw = recurring?.["interval_count"];
  const intervalCount = typeof countRaw === "number" ? countRaw : 1;

  const amount = price["unit_amount"];
  const label = priceLabel({
    amountMinor: typeof amount === "number" ? amount : null,
    currency: asString(price["currency"]),
    interval,
    intervalCount,
  });
  if (label !== undefined) return label;

  // Tiered and metered prices have no single unit amount to show.
  if (interval !== undefined) {
    return `Custom pricing${formatInterval(interval, intervalCount)}`;
  }

  return asString(price["id"]) ?? "Custom pricing";
}

/**
 * The fields synthesized onto a price before mapping.
 *
 * Four of them exist because the shape Stripe returns cannot survive the trip
 * through the mapper on its own:
 *
 *   `offering_name`  — see `offeringDisplayName`; `name` is required.
 *   `interval`       — nested under `recurring`, and absent entirely for a
 *                      one-time price. Flattened so a mapping rule is a single
 *                      path, and defaulted to `one_time` so "does not recur"
 *                      arrives as a value rather than a null the writer would
 *                      read as "not told".
 *   `product_id`     — `price.product` is a bare id string normally and an
 *                      expanded object when the caller asked for it. Reading
 *                      both here means the association does not silently break
 *                      if expansion is ever turned on.
 *   `billing_model`  — see `billingModelFromPrice`; spread across three nested
 *                      fields, so a mapping rule cannot combine it.
 */
export function flattenPrice(price: RawRecord): RawRecord {
  const recurring = asRecord(price["recurring"]);
  const interval = asString(recurring?.["interval"]);
  const countRaw = recurring?.["interval_count"];

  const createdAt = epochToIso(price["created"]);
  const billingModel = billingModelFromPrice(price);

  return {
    offering_name: offeringDisplayName(price),
    interval: interval ?? "one_time",
    interval_count: typeof countRaw === "number" ? countRaw : 1,
    product_id: priceProductId(price),
    ...(billingModel === undefined ? {} : { billing_model: billingModel }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  };
}

/**
 * The product id a price belongs to.
 *
 * Handles both forms Stripe can send: a bare id, or an expanded product object.
 */
export function priceProductId(price: RawRecord): string | undefined {
  const direct = asString(price["product"]);
  if (direct !== undefined) return direct;
  return asString(asRecord(price["product"])?.["id"]);
}

// ---------------------------------------------------------------------------
// Feature and entitlement
// ---------------------------------------------------------------------------

/**
 * One feature *definition*, lifted out of a feature attachment.
 *
 * Stripe nests the reusable definition under `entitlement_feature` on every
 * attachment returned by `/v1/products/{id}/features`. That definition is a
 * first-class object of its own — the `feat_…` id, the name, the lookup key and
 * the account's metadata — and this lifts it to a mappable top-level record.
 *
 * **The top-level `id` is the definition's, not the attachment's.** The reader
 * of `id` is `externalIdOf`, which is object-agnostic; a definition record left
 * carrying the attachment's `prodft_…` would be upserted under the wrong key,
 * silently and for every row. This is the trap `tests/unit/stripe-product-feature.test.ts`
 * exists to catch.
 *
 * The nested object is carried along unmodified so a raw
 * `entitlement_feature.*` mapping path — the metadata keys discovery offers —
 * still resolves against the record.
 *
 * @returns undefined when the attachment carries no definition id, because a
 *   definitionless attachment is not a feature and writing it with no id would
 *   only produce a rejection.
 */
export function flattenFeatureDefinition(
  feature: RawRecord
): RawRecord | undefined {
  const definition = asRecord(feature["entitlement_feature"]);
  const id = asString(definition?.["id"]);
  if (id === undefined) return undefined;

  return {
    id,
    feature_name: asString(definition?.["name"]),
    lookup_key: asString(definition?.["lookup_key"]),
    entitlement_feature: definition,
  };
}

/**
 * One entitlement *link*: this product includes that feature.
 *
 * The parent offering id is not in the payload. For Stripe's product-level
 * features, the attachment is read from `/v1/products/{id}/features` and the
 * response carries no product field — the offering id (which is the synthesised
 * sibling of the product, sharing its id) comes from *the URL the caller just
 * requested*. A caller that loses track of which offering it was fetching links
 * every row to the wrong offering **silently**: no error, no null, nothing to
 * notice. The argument is required rather than optional precisely so that losing
 * track is a type error.
 *
 * It is also injected *last* and unconditionally, so a record carrying a
 * misleading key of its own cannot win. The URL is the only authority here.
 *
 * The row's own `id` is the attachment's `prodft_…`, which is what keys an
 * entitlement; the feature it attaches is the definition's `feat_…`.
 */
export function flattenFeatureEntitlement(
  feature: RawRecord,
  offeringId: string
): RawRecord {
  const definition = asRecord(feature["entitlement_feature"]);

  return {
    // The attachment's own shape first — `livemode` and anything else Stripe
    // sends with it — then ours, so an injected id always wins over a
    // coincidental one in the payload.
    ...feature,
    id: asString(feature["id"]),
    feature_id: asString(definition?.["id"]),
    offering_id: offeringId,
  };
}

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

/**
 * Stripe's subscription statuses, mapped onto ours.
 *
 * Eight into six, and the two collapses are the interesting part:
 *
 *   `unpaid` → `past_due` — both mean "owes money and is still on the books".
 *   Stripe distinguishes them by how long that has been true and what dunning
 *   did about it, which is a billing-workflow detail rather than a fact about
 *   the agreement.
 *
 *   `incomplete` and `incomplete_expired` → `draft` — a subscription whose
 *   first payment never completed was never agreed to. Calling it `active`
 *   would put revenue in the total that no one ever committed to, and calling
 *   it `canceled` would count a churn that never had anything to churn from.
 *
 * Anything unrecognised returns undefined rather than a guess, and the writer
 * records a warning and leaves the column unset. A new Stripe status appearing
 * in a future API version should read as "we do not know" rather than silently
 * becoming whichever of ours sorts first.
 */
const STRIPE_SUBSCRIPTION_STATUS: Readonly<Record<string, string>> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "paused",
  canceled: "canceled",
  incomplete: "draft",
  incomplete_expired: "draft",
};

export function agreementStatusOf(subscription: RawRecord): string | undefined {
  const raw = asString(subscription["status"]);
  return raw === undefined ? undefined : STRIPE_SUBSCRIPTION_STATUS[raw];
}

/**
 * Our collection method, from Stripe's two words.
 *
 * Stripe states this as `charge_automatically` or `send_invoice`; ours is
 * `automatic` and `manual`, and the third member of our union — `none` — has no
 * Stripe spelling. `FieldTransform` has no enum-remap member, which is why this
 * translation lives here rather than as a mapping rule, exactly as status does
 * one function up. An unrecognised value returns `undefined` and the rule does
 * not fire, so the column stays null rather than holding a word the writer
 * would warn about.
 */
export function collectionMethodOf(
  subscription: RawRecord
): string | undefined {
  switch (asString(subscription["collection_method"])) {
    case "charge_automatically":
      return "automatic";
    case "send_invoice":
      return "manual";
    default:
      return undefined;
  }
}

/**
 * The primary line's cadence, and how many of those make a cycle.
 *
 * Read from the **first item's price**, which is the same line
 * `Agreement.offeringId` points at — so the cadence shown belongs to the price
 * shown. Stripe states `recurring.interval` and `interval_count` only on a
 * recurring price; a one-time price has neither, and a subscription whose lines
 * carry different intervals has no single cadence to report. Both cases return
 * `undefined` and the column stays null, which the column comment calls the
 * honest answer rather than a guess at the first line's rhythm.
 */
export function primaryBillingPeriod(
  subscription: RawRecord
): string | undefined {
  const recurring = asRecord(firstItemPrice(subscription)?.["recurring"]);
  return asString(recurring?.["interval"]);
}

export function primaryBillingPeriodCount(
  subscription: RawRecord
): number | undefined {
  const recurring = asRecord(firstItemPrice(subscription)?.["recurring"]);
  const count = recurring?.["interval_count"];
  // `interval_count` is numeric and never absent on a recurring price; a
  // non-number means something other than a Stripe recurring price, so there is
  // nothing to report.
  return typeof count === "number" && Number.isFinite(count) ? count : undefined;
}

/**
 * A record's `metadata` bag, serialized for a `providerMetadata` column.
 *
 * Stripe's `metadata` is flat and string-valued, so `JSON.stringify` is the
 * whole translation — no nesting to lose. Absent metadata returns `undefined`
 * rather than `"{}"`, so the mapping rule does not fire and the writer leaves
 * its default; an empty bag and no bag then read the same on the row, which is
 * correct because Stripe does not distinguish them.
 */
export function providerMetadataOf(record: RawRecord): string | undefined {
  const metadata = asRecord(record["metadata"]);
  return metadata === undefined ? undefined : JSON.stringify(metadata);
}

/**
 * How a line is priced, in our vocabulary.
 *
 * Stripe spreads this over `price.type`, `price.recurring.usage_type` and
 * `price.billing_scheme`, none of which is a thing a mapping rule can combine —
 * so it is read here and written as one word. The order matters: a one-time
 * price has no recurring block at all, and a metered price may still carry
 * `billing_scheme: "per_unit"`, so the more specific facts are tested first.
 *
 * `flat_fee` is deliberately never produced: Stripe has no spelling for it.
 * `billing_scheme` is only `per_unit` or `tiered`, and a flat price is
 * indistinguishable from a per-unit one in the payload. Returning `undefined`
 * for anything else is the same "we were not told" the column is nullable for.
 */
export function billingModelFromPrice(
  price: RawRecord
): string | undefined {
  if (asString(price["type"]) === "one_time") return "one_time";

  const recurring = asRecord(price["recurring"]);
  if (asString(recurring?.["usage_type"]) === "metered") return "usage_based";

  switch (asString(price["billing_scheme"])) {
    case "tiered":
      return "tiered";
    case "per_unit":
      return "per_unit";
    default:
      return undefined;
  }
}

/**
 * How a line is priced, in our vocabulary, from a subscription item.
 *
 * A thin wrapper over `billingModelFromPrice`: a subscription item nests the
 * price object under `price`, while a catalog price *is* the price object, and
 * both callers must agree on the reading.
 */
export function billingModelOf(item: RawRecord): string | undefined {
  const price = asRecord(item["price"]);
  return price === undefined ? undefined : billingModelFromPrice(price);
}

/**
 * The subscription items list, which Stripe returns inline on each record.
 *
 * **The first ten only.** Stripe paginates this list inside the subscription
 * and sets `items.has_more` when there are more, so this is the complete list
 * for the overwhelming majority of subscriptions and silently is not for a
 * large one. `subscriptionItemsComplete` below is how a caller asks, and the
 * agreement handler is obliged to finish the list before yielding any of it.
 */
export function subscriptionItems(
  subscription: RawRecord
): readonly RawRecord[] {
  const items = asRecord(subscription["items"]);
  return asArray(items?.["data"]).filter(
    (row): row is RawRecord => asRecord(row) !== undefined
  );
}

/**
 * Whether the inlined item list is the whole of it.
 *
 * Reads `items.has_more` and defaults to **complete** when the field is
 * missing, which is the right default for exactly one reason: Stripe always
 * sends `has_more` on a list object, so an absent one means the payload is not
 * a Stripe list — a fixture, a mock, or a hand-built record — and those carry
 * everything they have. Defaulting the other way would make every test fixture
 * trigger a pagination request against a URL no mock serves.
 */
export function subscriptionItemsComplete(subscription: RawRecord): boolean {
  return asRecord(subscription["items"])?.["has_more"] !== true;
}

/**
 * The price on a subscription's first item, as a full record.
 *
 * Stripe expands `price` inside subscription items by default, so this is the
 * whole price object rather than an id — which is what makes the name synthesis
 * below possible without a second request.
 *
 * "First item" is a real limitation, not a simplification: a subscription may
 * carry a base plan, a seat count and a metered add-on, and only one of them
 * ends up linked. `item_count` below is what makes that visible.
 */
function firstItemPrice(subscription: RawRecord): RawRecord | undefined {
  const first = subscriptionItems(subscription)[0];
  return first === undefined ? undefined : asRecord(first["price"]);
}

/**
 * A display name for a subscription.
 *
 * Stripe gives a subscription **no name at all** — not an empty one, none —
 * while `Agreement.name` is required. So this is not a nicety: without it every
 * subscription in the account is rejected for a missing name on every sync,
 * forever, with a `partial` run status as the only evidence. Exactly the trap
 * `offeringDisplayName` exists for, one object over.
 *
 * The layers are `offeringDisplayName`'s, because a subscription item carries
 * the whole price object and so has exactly the same material to work from:
 * nickname, then the money via `priceLabel`, then "Custom pricing" for a
 * tiered or metered price with no single amount. Sharing them is what makes a
 * subscription and the offering it points at actually read alike, rather than
 * merely intending to. The subscription id is the last resort, for a
 * subscription with no items at all.
 *
 * The product name would be better than the money and is deliberately not used:
 * `price.product` inside an item is a bare id, and resolving it would cost a
 * request per subscription to improve a string.
 */
export function agreementDisplayName(subscription: RawRecord): string {
  const price = firstItemPrice(subscription);

  // Delegated rather than reimplemented. The input is the same thing - a whole
  // price record - so the two were the same three layers written twice, and
  // they had already drifted: offeringDisplayName carries a "Custom
  // pricing/month" layer for tiered and metered prices and this did not, so a
  // tiered subscription read as "Custom pricing/month" on /catalog and as a
  // raw "sub_1U..." id on /agreements. Found against a seeded sandbox, not by
  // a test, because both were individually correct.
  if (price !== undefined) return offeringDisplayName(price);

  // Only reachable when the subscription has no items at all, which is why
  // this cannot delegate: the id to fall back to is the subscription's, not a
  // price that is not there.
  return asString(subscription["id"]) ?? "Subscription";
}

/**
 * A subscription period boundary, from wherever this API version keeps it.
 *
 * Stripe **moved `current_period_start` and `current_period_end` off the
 * subscription and onto each subscription item.** A sandbox created today
 * returns them only on the item; an account pinned to an older API version
 * returns them only on the subscription. This reads whichever is present.
 *
 * Reading one location only would be the quiet kind of wrong: the column would
 * be null for every row, the "Renews" cell empty on every agreement, and the
 * `currentPeriodEnd` sort order and its index both meaningless — with no error
 * anywhere, because a subscription legitimately *may* have no period.
 *
 * The item fallback uses the **first** item, which is the one whose price is
 * linked as the offering, so the period shown belongs to the price shown.
 */
function periodBoundary(
  subscription: RawRecord,
  field: "current_period_start" | "current_period_end"
): string | undefined {
  const own = epochToIso(subscription[field]);
  if (own !== undefined) return own;
  return epochToIso(subscriptionItems(subscription)[0]?.[field]);
}

/**
 * The fields synthesized onto a subscription before mapping.
 *
 * Same job as `flattenPrice`: everything here is either nested beyond the reach
 * of a single mapping path, in the wrong units, or absent entirely.
 *
 *   `agreement_name`  — see above; the column is required and Stripe has none.
 *   `agreement_type`  — constant `"subscription"` for this endpoint. Written
 *                       rather than defaulted so the discriminator comes from
 *                       the handler that knows, not from the writer guessing.
 *   `status`          — overwritten with our vocabulary, not Stripe's.
 *   `customer_id`     — `customer` is a bare id normally and an expanded object
 *                       when asked for; both are read, as `priceProductId` does.
 *   `offering_id`     — the offering the first item sells, read through its
 *                       price's `product`; the join to the catalog's Offering
 *                       row. The *price* is not this, and no longer stands in
 *                       for it: see `subscriptionOfferingId`.
 *   `item_count`      — how many priced lines exist, so that only-the-first is
 *                       a visible fact rather than a silent one.
 *   `collection_method` — translated to our `automatic`/`manual`, because a
 *                       `FieldTransform` cannot remap an enum.
 *   `billing_period`/  — the first item's price cadence, and its count. Read
 *   `billing_period_count` here rather than mapped from `items.0.price.recurring`,
 *                       which no single mapping path reaches.
 *   `provider_metadata` — Stripe's flat `metadata` bag, serialized to JSON.
 *   dates             — Unix epoch seconds through `epochToIso`, because every
 *                       date the writer accepts goes through `new Date(string)`.
 */
export function flattenSubscription(subscription: RawRecord): RawRecord {
  const items = subscriptionItems(subscription);
  const firstQuantity = items[0]?.["quantity"];

  const status = agreementStatusOf(subscription);
  const collectionMethod = collectionMethodOf(subscription);
  const billingPeriod = primaryBillingPeriod(subscription);
  const billingPeriodCount = primaryBillingPeriodCount(subscription);
  const providerMetadata = providerMetadataOf(subscription);

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["effective_date", "start_date"],
    ["trial_starts_at", "trial_start"],
    ["trial_ends_at", "trial_end"],
    ["canceled_at", "canceled_at"],
    // The *scheduled* cancellation moment, when there is one. Distinct from
    // `canceled_at` (requested) and from `cancel_at_period_end` (a flag), and
    // null for most subscriptions, which `epochToIso` turns into no key.
    ["cancel_at", "cancel_at"],
    ["ended_at", "ended_at"],
    ["created_at", "created"],
  ] as const) {
    const iso = epochToIso(subscription[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }

  // Read separately because they are not where the rest of the dates are; see
  // periodBoundary.
  for (const field of ["current_period_start", "current_period_end"] as const) {
    const iso = periodBoundary(subscription, field);
    if (iso !== undefined) dates[field] = iso;
  }

  return {
    agreement_name: agreementDisplayName(subscription),
    agreement_type: "subscription",
    // Omitted rather than null when Stripe sends a status we do not recognise,
    // so no mapping rule fires and the writer never sees a value to warn about
    // — the unknown status is the handler's problem, solved here.
    ...(status === undefined ? {} : { status }),
    // Stripe's own word for it, kept alongside ours under a name that cannot
    // collide with it. The mapping above collapses `unpaid` into `past_due`
    // and both `incomplete` states into `draft`, which is right for reporting
    // and lossy for anyone who needs the distinction — this is their way out,
    // and it is offered in the field list rather than left to be guessed.
    ...(asString(subscription["status"]) === undefined
      ? {}
      : { raw_status: asString(subscription["status"]) }),
    customer_id: subscriptionCustomerId(subscription),
    offering_id: subscriptionOfferingId(subscription),
    item_count: items.length,
    ...(typeof firstQuantity === "number" ? { quantity: firstQuantity } : {}),
    ...(collectionMethod === undefined
      ? {}
      : { collection_method: collectionMethod }),
    ...(billingPeriod === undefined
      ? {}
      : { billing_period: billingPeriod }),
    ...(billingPeriodCount === undefined
      ? {}
      : { billing_period_count: billingPeriodCount }),
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
    ...dates,
  };
}

/**
 * The customer id a subscription belongs to.
 *
 * Reads the bare-id and expanded-object forms for the same reason
 * `priceProductId` does: the association must not break silently if expansion
 * is ever turned on for this endpoint.
 */
export function subscriptionCustomerId(
  subscription: RawRecord
): string | undefined {
  const raw = subscription["customer"];
  const bare = asString(raw);
  if (bare !== undefined) return bare;
  return asString(asRecord(raw)?.["id"]);
}

/**
 * What kind of line an item is, when Stripe gives enough to say.
 *
 * It gives enough exactly once: a price whose `recurring.usage_type` is
 * `metered` is a usage line, which is a fact rather than a reading. Everything
 * else returns `undefined` and the column stays null.
 *
 * Not defaulted to `"plan"`, and this is the whole reason the function is one
 * line long rather than three. Stripe's subscription items are
 * undifferentiated — the base plan and a seat add-on are the same object with
 * different prices, and "the first one is the plan" is a convention of how
 * subscriptions are usually created, not something the API states. Writing
 * `"plan"` on every non-metered line would fill the column with a guess and
 * destroy the one thing it exists to record, which is whether the provider
 * actually said. Chargebee and Stigg do say; Stripe does not.
 */
export function itemTypeOf(item: RawRecord): string | undefined {
  const recurring = asRecord(asRecord(item["price"])?.["recurring"]);
  return asString(recurring?.["usage_type"]) === "metered"
    ? "usage"
    : undefined;
}

/**
 * The fields synthesized onto one subscription item before mapping.
 *
 * Two things make this unlike the flatteners above, and both are the reason it
 * takes three arguments where `flattenSubscription` takes one.
 *
 * **`agreement_id` is injected by the caller, never read from the record.**
 * Stripe's subscription item *does* carry a `subscription` field, which makes
 * this stricter than `flattenFeatureEntitlement`'s version of the same rule rather
 * than looser: there is a plausible-looking value right there in the payload
 * and it is deliberately ignored. A record that could name its own parent is a
 * record that could reassign itself to another agreement, and this is the one
 * writer that deletes — a line that jumped agreements would take its former
 * siblings with it. The caller holds the subscription it fetched these from;
 * that is the only id with any authority.
 *
 * **`position` is the caller's index, not anything Stripe sends.** It counts
 * across the *completed* list, including pages fetched separately, so it
 * orders the lines the way the provider returned them.
 *
 * **Both of the line's own ids come from the price it carries**, and they are
 * not interchangeable. `price_id` is what this line bills at; `offering_id` is
 * the offering it belongs to, which is the price's `product` — the synthesised
 * sibling of the product the catalog handler writes. A line carries both because
 * they answer different questions: *which* of an offering's prices was sold
 * (monthly or yearly), and *what* was sold. Only the price can answer the first,
 * which is exactly why the item table needs the column.
 *
 * `billing_model` and `provider_metadata` join `item_type` as synthesized
 * fields, for the same reason: both are readings of nested or split payload
 * facts a single mapping path cannot reach — see `billingModelOf`.
 */
export function flattenAgreementItem(
  item: RawRecord,
  subscriptionId: string,
  position: number
): RawRecord {
  const price = asRecord(item["price"]);
  const itemType = itemTypeOf(item);
  const billingModel = billingModelOf(item);
  const providerMetadata = providerMetadataOf(item);

  return {
    agreement_id: subscriptionId,
    price_id: asString(price?.["id"]),
    offering_id: price === undefined ? undefined : priceProductId(price),
    position,
    // Omitted rather than null, as `flattenSubscription` does for an
    // unrecognised status: no value means no mapping rule fires and the writer
    // never sees something to warn about.
    ...(itemType === undefined ? {} : { item_type: itemType }),
    ...(billingModel === undefined ? {} : { billing_model: billingModel }),
    ...(providerMetadata === undefined
      ? {}
      : { provider_metadata: providerMetadata }),
  };
}

/**
 * The offering a subscription's first line sells, or undefined if it names none.
 *
 * The *offering*, not the price. A subscription's line names a price, and the
 * offering is the product that price belongs to — the same synthesised sibling
 * of the product the catalog handler writes, which is what makes this resolvable
 * against the Offering row at all. Returning the price id here was the older
 * shape, from when one Stripe price *was* one of our offerings; an offering now
 * has several prices, so the price id would name a row that does not exist and
 * silently link nothing. `priceProductId` reads both the bare-id and expanded
 * forms of `product`, for the reason it documents.
 *
 * The first item only, and that limit is `Agreement.offeringId`'s own: one
 * agreement links one offering. Every other line is on the agreement's items,
 * each with its own price.
 */
export function subscriptionOfferingId(
  subscription: RawRecord
): string | undefined {
  const price = firstItemPrice(subscription);
  return price === undefined ? undefined : priceProductId(price);
}

// ---------------------------------------------------------------------------
// Billing
//
// Four resources feed one function, and each carries a different hazard:
//
//   `/v1/invoices`        one page yields one `invoice` per record.
//   `/v1/invoices/{id}/lines`  only reached when `lines.has_more` is set, the
//                         exact truncation hazard `subscriptionItemsUrl`
//                         exists for. Missing it would delete every line past
//                         the tenth on every sync.
//   `/v1/charges`         `payment` rows of `kind: "payment"`.
//   `/v1/refunds`         `payment` rows of `kind: "refund"`.
//   `/v1/invoice_payments` is read as an *index*, not as rows — see
//                         `flattenInvoicePaymentIndex`.
//
// A Stripe `Charge` and a `Refund` carry no invoice field at all on the pinned
// API version, so the invoice link can only come from `InvoicePayment`. That
// resource is an allocation (`inpay_…`) whose grain is not ours: taking it as
// the payment row would fill `invoiceId` but darken `method`, `disputed` and
// `failure_code` completely, because those live on the movement. So the index
// is built and the charge or refund remains the row.
// ---------------------------------------------------------------------------

/**
 * The line items inlined on an invoice, and whether that list is the whole of
 * it — the same pair `subscriptionItems`/`subscriptionItemsComplete` provide
 * one object over. Stripe inlines the first ten lines and sets
 * `lines.has_more` beyond that.
 */
export function invoiceLines(invoice: RawRecord): readonly RawRecord[] {
  const lines = asRecord(invoice["lines"]);
  return asArray(lines?.["data"]).filter(
    (row): row is RawRecord => asRecord(row) !== undefined
  );
}

export function invoiceLinesComplete(invoice: RawRecord): boolean {
  return asRecord(invoice["lines"])?.["has_more"] !== true;
}

/**
 * The lines of one invoice, as a filtered top-level list.
 *
 * The `subscriptionItemsUrl` shape: only reached when the inlined list was
 * truncated, with the same obligation — page it to exhaustion or fail, never
 * return a short list that licenses a wrongful delete.
 */
export function invoiceLinesUrl(
  invoiceId: string,
  limit: number,
  startingAfter?: string
): string {
  return paginatedUrl(
    `/v1/invoices/${encodeURIComponent(invoiceId)}/lines`,
    limit,
    startingAfter
  );
}

/**
 * Our invoice status, from Stripe's five.
 *
 * Stripe states exactly the members ours has for it, so this is a translation
 * of vocabulary rather than a collapse — but it still returns `undefined` for
 * anything unrecognised so a future Stripe status reads as "we do not know"
 * rather than silently becoming `open`.
 */
const STRIPE_INVOICE_STATUS: Readonly<Record<string, string>> = {
  draft: "draft",
  open: "open",
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
};

export function invoiceStatusOf(invoice: RawRecord): string | undefined {
  const raw = asString(invoice["status"]);
  return raw === undefined ? undefined : STRIPE_INVOICE_STATUS[raw];
}

/**
 * Our payment status, from a charge.
 *
 * Stripe's charge status is three-valued (`succeeded`/`pending`/`failed`) and
 * all three map across; the original plan omitted `pending`. A charge with
 * `refunded: true` is reported as `refunded` regardless of its own status,
 * because the movement a reader cares about has been returned.
 */
export function chargeStatusOf(charge: RawRecord): string | undefined {
  if (charge["refunded"] === true) return "refunded";
  switch (asString(charge["status"])) {
    case "succeeded":
      return "succeeded";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Our payment status, from a refund.
 *
 * A refund's own vocabulary differs from a charge's: `succeeded` becomes
 * `refunded` (the money was returned), `requires_action` is still an
 * unresolved flow so it reads as `pending`, and `canceled` is a failure of the
 * refund attempt.
 */
export function refundStatusOf(refund: RawRecord): string | undefined {
  switch (asString(refund["status"])) {
    case "succeeded":
      return "refunded";
    case "pending":
    case "requires_action":
      return "pending";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * The id behind a Stripe reference field.
 *
 * Reads both the bare-id and expanded-object forms, as `priceProductId` does —
 * the association must not break silently when `expand` is used.
 */
function referenceId(value: unknown): string | undefined {
  const bare = asString(value);
  if (bare !== undefined) return bare;
  return asString(asRecord(value)?.["id"]);
}

/**
 * The subscription an invoice belongs to, from wherever this API version keeps
 * it.
 *
 * **The sharpest edge in the billing handler.** On the pinned version
 * (2026-08-26.dahlia) the link is not at a top-level `subscription` field: it
 * is under `parent.subscription_details.subscription`, and the line-level
 * equivalent is `line.parent.invoice_item_details.subscription`. Reading one
 * spelling only would leave every invoice with no agreement, no warning, and
 * no null to notice — because null *is* the documented state for "we could not
 * resolve it". All three are read, in order of specificity.
 */
export function stripeInvoiceSubscriptionId(
  invoice: RawRecord
): string | undefined {
  const direct = referenceId(invoice["subscription"]);
  if (direct !== undefined) return direct;

  const details = asRecord(asRecord(invoice["parent"])?.["subscription_details"]);
  const fromParent = referenceId(details?.["subscription"]);
  if (fromParent !== undefined) return fromParent;

  for (const line of invoiceLines(invoice)) {
    const itemDetails = asRecord(
      asRecord(line["parent"])?.["invoice_item_details"]
    );
    const fromLine = referenceId(itemDetails?.["subscription"]);
    if (fromLine !== undefined) return fromLine;
  }

  return undefined;
}

export function stripeInvoiceCustomerId(
  invoice: RawRecord
): string | undefined {
  return referenceId(invoice["customer"]);
}

/**
 * A display value for a line's per-unit amount.
 *
 * Stripe's `pricing.unit_amount_decimal` is a decimal *string* that is
 * legitimately fractional for tiered or usage prices. It is returned verbatim,
 * so the record writer's `parseInteger` refuses a fractional value and leaves
 * `unitAmountMinor` null rather than truncating it. Falls back to the price's
 * integer `unit_amount` when the decimal form is absent.
 */
function lineUnitAmount(line: RawRecord): string | number | undefined {
  const pricing = asRecord(line["pricing"]);
  const decimal = asString(pricing?.["unit_amount_decimal"]);
  if (decimal !== undefined) return decimal;

  const price = asRecord(line["price"]);
  const unit = price?.["unit_amount"];
  return typeof unit === "number" ? unit : undefined;
}

/** Combine a charge's `failure_code` and `failure_message` for one column. */
function failureReasonOf(record: RawRecord): string | undefined {
  const code = asString(record["failure_code"]);
  const message = asString(record["failure_message"]);
  if (code !== undefined && message !== undefined) return `${code}: ${message}`;
  return code ?? message;
}

/**
 * The fields synthesized onto one invoice before mapping.
 *
 * Dates are the bulk of it: every date Stripe states is Unix epoch seconds and
 * the writer reads `new Date(string)`, and two of them live under
 * `status_transitions`. The subscription id is read through the three-spelling
 * helper above. `tax_minor` and `discount_minor` are deliberately absent —
 * Stripe carries arrays there, and null means "not stated".
 */
export function flattenStripeInvoice(invoice: RawRecord): RawRecord {
  const status = invoiceStatusOf(invoice);
  const rawStatus = asString(invoice["status"]);
  const transitions = asRecord(invoice["status_transitions"]);
  const metadata = providerMetadataOf(invoice);

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["issued_at", "finalized_at"],
    ["paid_at", "paid_at"],
  ] as const) {
    const iso = epochToIso(transitions?.[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }
  for (const [ours, theirs] of [
    ["due_at", "due_date"],
    ["period_start", "period_start"],
    ["period_end", "period_end"],
    ["created_at", "created"],
  ] as const) {
    const iso = epochToIso(invoice[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(rawStatus === undefined ? {} : { raw_status: rawStatus }),
    // Stripe's `number` is null on a draft; `asString` drops it so no rule
    // fires and the column stays null.
    ...(asString(invoice["number"]) === undefined
      ? {}
      : { number: asString(invoice["number"]) }),
    customer_id: stripeInvoiceCustomerId(invoice),
    // The agreement link, from whichever spelling this version carries.
    agreement_id: stripeInvoiceSubscriptionId(invoice),
    ...(metadata === undefined ? {} : { provider_metadata: metadata }),
    ...dates,
  };
}

/**
 * The fields synthesized onto one invoice line before mapping.
 *
 * `invoice_id` is injected by the caller from the invoice it was read from —
 * the line carries its own `invoice` field and it is deliberately ignored, for
 * `flattenAgreementItem`'s reason: this is a writer that deletes, so a line
 * must not be able to name a different parent.
 */
export function flattenStripeInvoiceLine(
  line: RawRecord,
  invoiceId: string
): RawRecord {
  const period = asRecord(line["period"]);
  const price = asRecord(line["price"]);
  const parent = asRecord(line["parent"]);
  const itemDetails = asRecord(parent?.["invoice_item_details"]);

  const metadata = providerMetadataOf(line);
  const unitAmount = lineUnitAmount(line);

  const proration = itemDetails?.["proration"];

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["period_start", "start"],
    ["period_end", "end"],
  ] as const) {
    const iso = epochToIso(period?.[theirs]);
    if (iso !== undefined) dates[ours] = iso;
  }

  return {
    invoice_id: invoiceId,
    price_id: asString(price?.["id"]),
    offering_id: price === undefined ? undefined : priceProductId(price),
    ...(unitAmount === undefined ? {} : { unit_amount_minor: unitAmount }),
    // Only Stripe states a proration fact, and it states it here. Absent for
    // Chargebee, which is why the column is nullable.
    ...(typeof proration === "boolean" ? { is_proration: proration } : {}),
    // Deliberately the only member of INVOICE_LINE_TYPES Stripe can populate: a
    // proration line. Everything else on a Stripe invoice line is a plan, an
    // add-on or a charge the API does not distinguish, so the column stays
    // null rather than guessing.
    ...(proration === true ? { item_type: "proration" } : {}),
    ...(metadata === undefined ? {} : { provider_metadata: metadata }),
    ...dates,
  };
}

/**
 * The fields synthesized onto one charge, as a `payment` of kind `payment`.
 *
 * `invoice_id` arrives from the `InvoicePayment` index, because a charge has no
 * invoice field. It is `undefined` when the index had no entry — a real state,
 * and the writer warns and leaves the link null rather than guessing.
 */
export function flattenStripeCharge(
  charge: RawRecord,
  invoiceId: string | undefined
): RawRecord {
  const status = chargeStatusOf(charge);
  const method = asString(
    asRecord(charge["payment_method_details"])?.["type"]
  );
  const failureReason = failureReasonOf(charge);
  const providerReference = referenceId(charge["balance_transaction"]);
  const processedAt = epochToIso(charge["created"]);
  // `amount_refunded` has no column of its own — a refund is written as its own
  // `payment` row — so it is kept beside the provider metadata rather than
  // dropped. It is the one field a reader reconciling a partially-refunded
  // charge would otherwise have to refetch from Stripe.
  const metadataParts: Record<string, unknown> = {
    ...(asRecord(charge["metadata"]) ?? {}),
  };
  const amountRefunded = charge["amount_refunded"];
  if (typeof amountRefunded === "number" && amountRefunded > 0) {
    metadataParts["amount_refunded"] = amountRefunded;
  }
  const metadata =
    Object.keys(metadataParts).length === 0
      ? undefined
      : JSON.stringify(metadataParts);

  return {
    kind: "payment",
    ...(status === undefined ? {} : { status }),
    ...(asString(charge["status"]) === undefined
      ? {}
      : { raw_status: asString(charge["status"]) }),
    ...(invoiceId === undefined ? {} : { invoice_id: invoiceId }),
    customer_id: referenceId(charge["customer"]),
    ...(method === undefined ? {} : { method }),
    ...(failureReason === undefined
      ? {}
      : { failure_reason: failureReason.slice(0, 255) }),
    // Stripe always sends `disputed`, so a boolean is ordinary rather than a
    // guess. A charge that is not disputed is `false`, which the nullable
    // column holds as the fact it is.
    is_disputed: charge["disputed"] === true,
    ...(providerReference === undefined
      ? {}
      : { provider_reference: providerReference }),
    ...(processedAt === undefined ? {} : { processed_at: processedAt }),
    ...(metadata === undefined ? {} : { provider_metadata: metadata }),
  };
}

/**
 * The fields synthesized onto one refund, as a `payment` of kind `refund`.
 *
 * `refund.payment_intent` (or `refund.charge`) is the same index key as a
 * charge's; `refund.invoice` does not exist and is not read.
 */
export function flattenStripeRefund(
  refund: RawRecord,
  invoiceId: string | undefined
): RawRecord {
  const status = refundStatusOf(refund);
  const providerReference = referenceId(refund["balance_transaction"]);
  const processedAt = epochToIso(refund["created"]);
  const metadata = providerMetadataOf(refund);

  return {
    kind: "refund",
    ...(status === undefined ? {} : { status }),
    ...(asString(refund["status"]) === undefined
      ? {}
      : { raw_status: asString(refund["status"]) }),
    ...(invoiceId === undefined ? {} : { invoice_id: invoiceId }),
    ...(providerReference === undefined
      ? {}
      : { provider_reference: providerReference }),
    ...(processedAt === undefined ? {} : { processed_at: processedAt }),
    ...(metadata === undefined ? {} : { provider_metadata: metadata }),
  };
}

/**
 * All of a charge's or refund's payment-intent keys, so the index can be looked
 * up from whichever one the row carries.
 *
 * A charge carries `payment_intent`; a refund carries `payment_intent` and
 * `charge`. Any of them is enough to find the `InvoicePayment` entry.
 */
export function paymentIntentKeysOf(record: RawRecord): string[] {
  const keys: string[] = [];
  const intent = referenceId(record["payment_intent"]);
  if (intent !== undefined) keys.push(intent);
  const charge = referenceId(record["charge"]);
  if (charge !== undefined && charge !== intent) keys.push(charge);
  return keys;
}

/**
 * Build the payment-object → invoice-id index from a page of
 * `InvoicePayment` records.
 *
 * This is the only resource that maps a payment object to an invoice: a Stripe
 * `Charge` and a `Refund` carry no invoice field on the pinned version. Each
 * entry is keyed by **both** the payment intent id and, when the allocation
 * names a charge rather than an intent, that charge id — so a row can be looked
 * up regardless of which key it happens to carry.
 *
 * The lookup is the return value rather than any row: nothing from an
 * `InvoicePayment` is written, because its grain is the allocation and taking
 * it as our payment row would darken `method` and `disputed` on every charge.
 */
export function flattenInvoicePaymentIndex(
  records: readonly RawRecord[]
): Map<string, string> {
  const index = new Map<string, string>();

  for (const record of records) {
    const invoiceId = referenceId(record["invoice"]);
    if (invoiceId === undefined) continue;

    const payment = asRecord(record["payment"]);
    const intent = referenceId(payment?.["payment_intent"]);
    if (intent !== undefined) index.set(intent, invoiceId);

    // Some allocations name a charge directly instead of an intent.
    const charge = referenceId(record["charge"]);
    if (charge !== undefined) index.set(charge, invoiceId);
  }

  return index;
}

/**
 * Look a movement's invoice up in the index, trying every key it carries.
 *
 * Returns `undefined` when none is present, which is the honest answer for a
 * charge raised outside an invoice and for an index page lost to the page
 * bound. The writer warns and leaves the link null — never a guess.
 */
export function invoiceIdFromIndex(
  record: RawRecord,
  index: ReadonlyMap<string, string>
): string | undefined {
  for (const key of paymentIntentKeysOf(record)) {
    const invoiceId = index.get(key);
    if (invoiceId !== undefined) return invoiceId;
  }
  return undefined;
}
