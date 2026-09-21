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
] as const;

export type StripeResource = (typeof STRIPE_RESOURCES)[number];

/**
 * A `/v1/<resource>` list URL with Stripe's cursor pagination applied.
 *
 * One builder for every resource, because Stripe's list endpoints are uniform:
 * same `limit`, same `starting_after`, same envelope. Three near-identical URL
 * builders would be three places for the cursor parameter to be misspelled.
 */
export function listUrl(
  resource: StripeResource,
  limit: number,
  startingAfter?: string,
  extra?: Readonly<Record<string, string>>
): string {
  // Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
  // base's own path entirely, which would silently strip any prefix a mock or
  // proxy is mounted under.
  const url = new URL(`${stripeApiBase().replace(/\/$/, "")}/v1/${resource}`);
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
 * Three of them exist because the shape Stripe returns cannot survive the trip
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
 */
export function flattenPrice(price: RawRecord): RawRecord {
  const recurring = asRecord(price["recurring"]);
  const interval = asString(recurring?.["interval"]);
  const countRaw = recurring?.["interval_count"];

  const createdAt = epochToIso(price["created"]);

  return {
    offering_name: offeringDisplayName(price),
    interval: interval ?? "one_time",
    interval_count: typeof countRaw === "number" ? countRaw : 1,
    product_id: priceProductId(price),
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

/** The subscription items list, which Stripe returns inline on each record. */
function subscriptionItems(subscription: RawRecord): readonly RawRecord[] {
  const items = asRecord(subscription["items"]);
  return asArray(items?.["data"]).filter(
    (row): row is RawRecord => asRecord(row) !== undefined
  );
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
 *   `offering_id`     — the first item's price id, which is the join to the
 *                       catalog's Offering row.
 *   `item_count`      — how many priced lines exist, so that only-the-first is
 *                       a visible fact rather than a silent one.
 *   dates             — Unix epoch seconds through `epochToIso`, because every
 *                       date the writer accepts goes through `new Date(string)`.
 */
export function flattenSubscription(subscription: RawRecord): RawRecord {
  const price = firstItemPrice(subscription);
  const items = subscriptionItems(subscription);
  const firstQuantity = items[0]?.["quantity"];

  const status = agreementStatusOf(subscription);

  const dates: Record<string, string> = {};
  for (const [ours, theirs] of [
    ["effective_date", "start_date"],
    ["trial_ends_at", "trial_end"],
    ["canceled_at", "canceled_at"],
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
    offering_id: asString(price?.["id"]),
    item_count: items.length,
    ...(typeof firstQuantity === "number" ? { quantity: firstQuantity } : {}),
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

/** The price id a subscription's first item names, or undefined if it has none. */
export function subscriptionOfferingId(
  subscription: RawRecord
): string | undefined {
  return asString(firstItemPrice(subscription)?.["id"]);
}
