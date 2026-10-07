/**
 * Stigg REST specifics: base URL, opaque-cursor pagination, the synthesis of a
 * billing contact from the customer's own fields, and the catalog resource
 * builders and flattens.
 *
 * Two shapes here carry the risk:
 *
 *   1. Pagination. Stigg hands back an opaque `pagination.next` cursor rather
 *      than deriving one from ids, which makes termination the server's signal
 *      — but the docs' "REST Overview" page describes a different contract
 *      (`starting_after`/`has_more`/`next_cursor`) from the OpenAPI spec and
 *      generated SDKs (`after` + `pagination.next`). The OpenAPI shape is taken
 *      as authoritative and parsing is isolated here so a live-key correction
 *      is one function plus the msw handlers.
 *   2. There is no contact resource at all, so like Stripe the contact is
 *      *constructed* from the customer's own `name`/`email` rather than read
 *      from the payload.
 *
 * Docs: https://docs.stigg.io/api
 */

import type { BillingInterval, BillingModel, RawRecord } from "../../types/common";
import { priceLabel } from "../../price-format";
import { asArray, asRecord, asString } from "../http";

/** Records per page. Stigg's own default is 20; its documented maximum is 100. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Runaway guard.
 *
 * `pagination.next` terminates, but it is an opaque value the server issues and
 * a server that kept minting fresh cursors would page until the process died.
 * The bound is on us rather than on its good behaviour, as Metrifox's and
 * Stripe's are.
 */
export const STIGG_MAX_PAGES = 1000;

/** How many customers discovery samples to find environment-specific metadata keys. */
export const STIGG_DISCOVERY_SAMPLE = 25;

/**
 * Base URL for the Stigg API.
 *
 * Overridable so tests and a local mock can point elsewhere, exactly like
 * `metrifoxApiBase()`.
 */
export function stiggApiBase(): string {
  const base = process.env["STIGG_API_BASE"];
  const resolved =
    base === undefined || base === "" ? "https://api.stigg.io" : base;

  // The API key travels in a header on every one of these requests. A base
  // that is neither HTTPS nor loopback would put a live credential on the
  // wire in clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(
      `STIGG_API_BASE must use https (or localhost); got '${resolved}'`,
    );
  }
  return resolved;
}

export function stiggPageSize(): number {
  const raw = process.env["STIGG_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * A Stigg URL for any path, concatenated onto the base.
 *
 * Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
 * base's own path entirely, which would silently strip any prefix a mock or
 * proxy is mounted under.
 */
function resourceUrl(path: string): string {
  return `${stiggApiBase().replace(/\/$/, "")}${path}`;
}

/**
 * A paginated Stigg URL for any path, with the cursor parameters applied.
 *
 * Private, and the sole implementation of Stigg's pagination convention. Every
 * list endpoint shares it — same `limit`, same opaque `after` — so adding a
 * resource is one wrapper below rather than another copy of this.
 */
function listUrl(path: string, limit: number, after?: string): string {
  const url = new URL(resourceUrl(path));
  url.searchParams.set("limit", String(limit));
  // The cursor is echoed verbatim, never constructed: it is opaque and
  // server-owned, unlike Stripe's id-derived `starting_after`.
  if (after !== undefined) url.searchParams.set("after", after);
  return url.toString();
}

export function customersUrl(limit: number, after?: string): string {
  return listUrl("/api/v1/customers", limit, after);
}

export function productsUrl(limit: number, after?: string): string {
  return listUrl("/api/v1/products", limit, after);
}

export function plansUrl(limit: number, after?: string): string {
  return listUrl("/api/v1/plans", limit, after);
}

export function addonsUrl(limit: number, after?: string): string {
  return listUrl("/api/v1/addons", limit, after);
}

export function featuresUrl(limit: number, after?: string): string {
  return listUrl("/api/v1/features", limit, after);
}

/**
 * The charges on one plan or addon.
 *
 * The package id is percent-encoded: belt and braces for Stigg's own ids, and
 * load-bearing for anything a mock or proxy returns, because this is a path
 * segment built from response data rather than from a literal.
 */
export function planChargesUrl(
  planId: string,
  limit: number,
  after?: string,
): string {
  return listUrl(
    `/api/v1/plans/${encodeURIComponent(planId)}/charges`,
    limit,
    after,
  );
}

export function addonChargesUrl(
  addonId: string,
  limit: number,
  after?: string,
): string {
  return listUrl(
    `/api/v1/addons/${encodeURIComponent(addonId)}/charges`,
    limit,
    after,
  );
}

/**
 * The entitlements of one package.
 *
 * Deliberately **not** through `listUrl`: these endpoints document no
 * `limit`/`after` parameters, so there is no cursor to apply. One request per
 * package is the contract — see the catalog handler.
 */
export function planEntitlementsUrl(planId: string): string {
  return resourceUrl(
    `/api/v1/plans/${encodeURIComponent(planId)}/entitlements`,
  );
}

export function addonEntitlementsUrl(addonId: string): string {
  return resourceUrl(
    `/api/v1/addons/${encodeURIComponent(addonId)}/entitlements`,
  );
}

export interface StiggPage {
  readonly records: readonly RawRecord[];
  /**
   * Cursor for the next request, or undefined on the last page. Trusted over
   * any count field because it is what the API documents as the end signal.
   */
  readonly nextCursor: string | undefined;
}

/**
 * Read one Stigg list response.
 *
 * Resource-agnostic, and always was: every list endpoint returns the same
 * `{ data, pagination }` envelope, so products, plans, addons, features and
 * charges page through exactly this parser rather than copies of it.
 *
 * `pagination.next` is the provider's own end-of-data signal the way Metrifox's
 * `meta.next_page` and Stripe's `has_more` are. `null` and an absent field both
 * mean the same thing here, which `asString` already collapses.
 */
export function parseStiggPage(json: unknown): StiggPage {
  const body = asRecord(json);
  const data = asArray(body?.["data"]);
  const pagination = asRecord(body?.["pagination"]);

  return {
    records: data.filter(
      (row): row is RawRecord => asRecord(row) !== undefined,
    ),
    nextCursor: asString(pagination?.["next"]),
  };
}

/** Back-compat alias, for call sites that only ever read customers. */
export const parseCustomersPage = parseStiggPage;

// ---------------------------------------------------------------------------
// Synthesized fields
// ---------------------------------------------------------------------------

/**
 * The stable synthetic id for a customer's billing contact.
 *
 * ALGORITHM v1 — changing this re-keys every existing Stigg contact. `Contact`
 * is unique on `(integrationId, externalSourceId)`, so an id that shifts
 * between runs does not error: it silently inserts a duplicate person and
 * orphans the old row.
 *
 * A *constant* slot, as Stripe's and Chargebee's are: there is exactly one
 * contact per customer by construction, so deriving the id from the email would
 * buy nothing and cost everything — an address correction would re-key the row.
 * Stigg slugs cannot contain `:`, so this cannot collide with a customer id.
 */
export function stiggContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing-contact record for one Stigg customer.
 *
 * Deliberately not a spread of the customer, for the same two reasons Stripe's
 * `synthesizeContact` is not: `externalIdOf` falls back to `id` for customers,
 * so a contact carrying the customer's `id` would make that fallback ambiguous;
 * and `STIGG_CONTACT_FIELDS` is a static list, so a spread would put every
 * customer field onto contact records the mapping editor never offers.
 *
 * Stigg has no `phone`, so that key is absent relative to Stripe's version.
 *
 * Read from the **raw** customer, not the record `withCustomerName` patched:
 * that fallback makes every nameless customer's name equal to its id, which
 * would shadow the email local part this function prefers. The caller passes
 * the record Stigg actually returned.
 *
 * @returns The record, or undefined only when the customer has no id, which
 *   nothing downstream could key the row by. Every other customer yields a
 *   contact: the id is the final name fallback, so the required
 *   `Contact.name` is always non-empty.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const name = nonEmpty(asString(customer["name"])?.trim());
  const email = nonEmpty(asString(customer["email"])?.trim());

  // Three layers, best first. Stigg's `name` is whatever was put there — a
  // person for a consumer business, a company for a B2B one. The email local
  // part is the fallback, which is at least recognisable to whoever set the
  // address. The customer id is last so an email is never shadowed by it, and
  // so a customer with neither still produces the required `Contact.name`.
  const contactName =
    name ?? (email === undefined ? customerId : localPart(email));

  return {
    contact_id: stiggContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    customer_id: customerId,
    // The customer's effective name, whole: the id the customer record falls
    // back to when Stigg gave no name.
    customer_name: name ?? customerId,
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

/**
 * The name to write for a Stigg customer when Stigg did not give one.
 *
 * `Customer.name` is required, while Stigg's `name` is nullable — so a nameless
 * customer would be rejected for "Name is required" on every sync, forever, and
 * never appear. The customer's own id is the fallback, deliberately: it always
 * exists, it is stable, and it is a recognisable handle for a record the user
 * can then rename by hand.
 *
 * Returning a spreadable object rather than a value keeps a missing id from
 * writing `name: undefined` onto the record, which the mapping editor would
 * then offer as a field that is always blank. A name already present is left
 * untouched: this is a fallback, not an overwrite.
 */
export function withCustomerName(customer: RawRecord): RawRecord {
  const id = asString(customer["id"]);
  if (id === undefined) return {};

  return nonEmpty(asString(customer["name"])?.trim()) === undefined
    ? { name: id }
    : {};
}

/**
 * The `crossRef.stripe` source, flattened onto the customer record.
 *
 * A Stigg customer's link to its Stripe counterpart lives in `integrations[]`
 * as `{ vendorIdentifier: "STRIPE", syncedEntityId }`. `readPath` walks dot
 * segments with own-property guards but cannot index an array, so a mapping
 * rule cannot reach `integrations.0.syncedEntityId`; the handler flattens the
 * Stripe id onto the record as `stripe_customer_id` while it still has the
 * array.
 *
 * Deliberately **not** read from `billingId`. That field names the customer in
 * whichever billing provider is connected — Stripe **or** Zuora — so feeding it
 * to `crossRef.stripe` would assert a Stripe id that may be a Zuora entity. It
 * goes to `customFields.billing_id` in the defaults instead.
 *
 * @returns `{ stripe_customer_id }` when a STRIPE integration carries a
 *   non-empty `syncedEntityId`, otherwise `{}` so no rule fires. A missing or
 *   non-Stripe list is the safe direction: no field, no cross-reference, no
 *   false join.
 */
export function withStripeLink(customer: RawRecord): RawRecord {
  const stripe = asArray(customer["integrations"])
    .map((entry) => asRecord(entry))
    .find((integration) => asString(integration?.["vendorIdentifier"]) === "STRIPE");

  const syncedEntityId = asString(stripe?.["syncedEntityId"]);
  return syncedEntityId === undefined ? {} : { stripe_customer_id: syncedEntityId };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Narrow to a finite number, or undefined.
 *
 * Local rather than shared for the same reason Stripe's `epochToIso` documents:
 * a single caller does not justify widening a file every provider imports.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `active` from a Stigg status, as a spreadable addition.
 *
 * Only Stigg's `PUBLISHED` state is sellable; `DRAFT` and `ARCHIVED` are known
 * non-published states. A missing status writes nothing, so `active: null`
 * keeps meaning "Stigg did not tell us" rather than a guessed `false`.
 */
export function activeFromStatus(record: RawRecord): RawRecord {
  const status = asString(record["status"]);
  if (status === undefined) return {};
  return { active: status === "PUBLISHED" };
}

/**
 * Keep only the packages Stigg says are published.
 *
 * The catalog is for sale, so `DRAFT` and `ARCHIVED` packages are dropped
 * rather than emitted with `active: false`. A package whose status is absent is
 * not *confirmed* sellable, so it is dropped too — the same fail-closed read as
 * `active`. Applied before `bestCatalogVersion`, so version selection then only
 * ever chooses among published packages.
 */
export function publishedOnly(records: readonly RawRecord[]): RawRecord[] {
  return records.filter(
    (record) => asString(record["status"]) === "PUBLISHED",
  );
}

/**
 * Keep one version per package id, preferring the one that is for sale.
 *
 * Editing a Stigg package produces a new version under the **same id**, and a
 * list can in principle carry several. Order of preference: the highest
 * `versionNumber` among `PUBLISHED` records; if none is published, the highest
 * overall; ties to `isLatest`. Published-first is load-bearing — a newer
 * *draft* version must not hide the version currently being sold behind
 * `active: false`. A record with no id is dropped, since nothing can key it.
 *
 * The handler pre-filters with `publishedOnly`, so the published-first branch is
 * only reached when this is used on its own; the fallback stays because the
 * function is general. Grouping is per call, so plans and addons are deduped
 * separately and cannot collide across the two lists.
 */
export function bestCatalogVersion(
  records: readonly RawRecord[],
): RawRecord[] {
  const groups = new Map<string, RawRecord[]>();
  for (const record of records) {
    const id = asString(record["id"]);
    if (id === undefined) continue;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [record]);
    else group.push(record);
  }

  const chosen: RawRecord[] = [];
  for (const group of groups.values()) {
    const published = group.filter(
      (record) => asString(record["status"]) === "PUBLISHED",
    );
    const pool = published.length > 0 ? published : group;
    chosen.push(pool.reduce((best, candidate) => (betterVersion(candidate, best) ? candidate : best)));
  }
  return chosen;
}

/** Whether `candidate` should win over `best`: higher version, then `isLatest`. */
function betterVersion(candidate: RawRecord, best: RawRecord): boolean {
  const next = asNumber(candidate["versionNumber"]);
  const current = asNumber(best["versionNumber"]);
  if (next !== current) {
    return (next ?? Number.NEGATIVE_INFINITY) > (current ?? Number.NEGATIVE_INFINITY);
  }
  return candidate["isLatest"] === true && best["isLatest"] !== true;
}

/**
 * A package (plan or addon) a charge or entitlement hangs off.
 *
 * `kind` is carried because the two live under different URL prefixes, and a
 * deduped id no longer remembers which list it came from.
 */
export interface StiggPackage {
  readonly id: string;
  readonly name: string;
  readonly kind: "plan" | "addon";
  readonly active?: boolean;
}

/**
 * A charge's interval, in our vocabulary.
 *
 * Synthesized because a raw transform cannot map two provider fields onto one
 * enum. `ONE_OFF` wins over `billingPeriod`: a one-off charge that still carries
 * `MONTHLY` does not recur. An unrecognised or absent cadence returns undefined
 * (both interval fields are then omitted), because null means "not told" and
 * Stigg not saying must not read as `one_time`.
 */
export function stiggInterval(charge: RawRecord): BillingInterval | undefined {
  if (asString(charge["billingCadence"]) === "ONE_OFF") return "one_time";
  switch (asString(charge["billingPeriod"])) {
    case "MONTHLY":
      return "month";
    case "ANNUALLY":
      return "year";
    default:
      return undefined;
  }
}

/**
 * The billing-model word for a charge with no single amount to show.
 *
 * Same role Stripe's "Custom pricing" plays: tiered and usage charges carry no
 * `price`, so the money cannot be named — but the model can.
 */
function billingModelLabel(charge: RawRecord): string | undefined {
  switch (asString(charge["billingModel"])) {
    case "USAGE_BASED":
      return "usage-based";
    case "PER_UNIT":
      return "per unit";
    case "MINIMUM_SPEND":
      return "minimum spend";
    case "CREDIT_BASED":
      return "credits";
    default:
      return undefined;
  }
}

/**
 * The canonical billing-model word for a charge, or undefined when Stigg states
 * a value outside our vocabulary.
 *
 * Stigg is the only provider that says `MINIMUM_SPEND` or `CREDIT_BASED`; both
 * are in `BILLING_MODELS`. The mapping is case-only for four values and is done
 * here rather than as a mapping rule because a transform cannot rewrite a value.
 */
export function stiggBillingModel(charge: RawRecord): BillingModel | undefined {
  switch (asString(charge["billingModel"])) {
    case "FLAT_FEE":
      return "flat_fee";
    case "PER_UNIT":
      return "per_unit";
    case "USAGE_BASED":
      return "usage_based";
    case "MINIMUM_SPEND":
      return "minimum_spend";
    case "CREDIT_BASED":
      return "credit_based";
    default:
      return undefined;
  }
}

/**
 * A Stigg charge amount as minor units.
 *
 * Stigg states `price.amount` in the currency's **major** unit (49 = $49.00),
 * while our `Price.amountMinor` — and `priceLabel`, which divides by the
 * currency's exponent — expects minor units. The exponent is currency-specific
 * (JPY and KRW have none), so it comes from `Intl` rather than a hardcoded 100:
 * ¥4,900 must stay 4900 and not become 490000.
 */
function toMinorUnits(amount: number, currency: string | undefined): number {
  return amount * 10 ** minorUnitExponent(currency);
}

/** How many decimal places a currency has; 2 for an unknown or absent code. */
function minorUnitExponent(currency: string | undefined): number {
  if (currency === undefined) return 2;
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * The fields synthesized onto a charge before mapping.
 *
 * `Price.name` is required and a charge has no name of its own, so the name is
 * built from the package plus the best label the payload allows: the shared
 * `priceLabel` (amount + recurrence, so this reads like the Stripe catalog),
 * then the billing-model word for a price-less charge, then "custom pricing".
 * A metered feature and a country are appended so localized and multi-feature
 * charges stay distinguishable.
 *
 * The amount is stated in **major units** and converted to minor ones
 * (`amount_minor`) for both the name and the canonical column; this is the one
 * place the units assumption lives.
 */
export function flattenCharge(
  charge: RawRecord,
  pkg: StiggPackage,
): RawRecord {
  const price = asRecord(charge["price"]);
  const amount = asNumber(price?.["amount"]);
  const currency = asString(price?.["currency"]);
  const interval = stiggInterval(charge);
  const billingModel = stiggBillingModel(charge);

  const amountMinor =
    amount === undefined ? undefined : toMinorUnits(amount, currency);

  const label =
    priceLabel({
      amountMinor: amountMinor ?? null,
      currency: currency ?? null,
      interval: interval ?? null,
      intervalCount: 1,
    }) ??
    billingModelLabel(charge) ??
    "custom pricing";

  const featureId = asString(charge["featureId"]);
  const country = asString(charge["billingCountryCode"]);
  const suffix =
    (featureId === undefined ? "" : ` · ${featureId}`) +
    (country === undefined ? "" : ` (${country})`);

  return {
    offering_id: pkg.id,
    price_name: `${pkg.name} — ${label}${suffix}`,
    // The converted amount, so the defaults map it straight to `amountMinor`.
    // The raw `price.amount` stays on the record, in major units, for anyone
    // who wants it.
    ...(amountMinor === undefined ? {} : { amount_minor: amountMinor }),
    // Omitted rather than null for an unrecognised cadence: no value means no
    // mapping rule fires, and the writer never sees something to warn about.
    ...(interval === undefined
      ? {}
      : { interval, interval_count: 1 }),
    // The canonical model word, so the defaults can map it straight to
    // `billingModel`. Omitted when Stigg's value is outside our vocabulary, so
    // no mapping rule fires and the column stays null rather than wrong.
    ...(billingModel === undefined ? {} : { billing_model: billingModel }),
    ...(pkg.active === undefined ? {} : { active: pkg.active }),
  };
}

/**
 * The fields synthesized onto a feature definition before mapping.
 *
 * A raw rule cannot map `meterType` onto a boolean, and `None` is a value
 * rather than an absence, so the reading happens here. An absent `meterType`
 * emits nothing — Stigg did not tell us, which is different from `None`.
 */
export function flattenFeature(feature: RawRecord): RawRecord {
  const meterType = asString(feature["meterType"]);
  return meterType === undefined ? {} : { isMetered: meterType !== "None" };
}

/**
 * The stable synthetic id for a package's entitlement on one feature.
 *
 * ALGORITHM v1 — changing this re-keys every existing Stigg entitlement.
 *
 * The payload's entitlement `id` is the **feature** id, which repeats on every
 * plan that includes that feature, and `Entitlement` is unique on
 * `(integrationId, externalSourceId)`. Used raw it would collapse the
 * plan × feature matrix onto one row per feature. The pair cannot collide:
 * there is one entitlement per feature per package, and Stigg ids cannot
 * contain `:`.
 */
export function stiggEntitlementExternalId(
  packageId: string,
  featureId: string,
): string {
  return `${packageId}:${featureId}`;
}

/**
 * The provider's answer for a feature entitlement, as a string.
 *
 * An explicit denial is a real answer ("false"), unlimited is "unlimited", a
 * numeric limit is its number, and a grant with neither is "true". The raw
 * `usageLimit` still reaches `limitValue` through the defaults.
 */
export function stiggEntitlementValue(entitlement: RawRecord): string {
  if (entitlement["isGranted"] === false) return "false";
  if (entitlement["hasUnlimitedUsage"] === true) return "unlimited";
  const usageLimit = asNumber(entitlement["usageLimit"]);
  if (usageLimit !== undefined) return String(usageLimit);
  return "true";
}

/**
 * The fields synthesized onto one entitlement before mapping.
 *
 * `feature_id` is the raw `id` (the feature the entitlement configures) and is
 * guarded non-empty: an entitlement naming no feature can be neither keyed nor
 * linked, so it yields nothing rather than a record full of nulls. Only
 * `FEATURE`-type entitlements reach here — CREDIT ones are dropped by the
 * handler, as they describe a custom-currency pool rather than a capability.
 */
export function flattenEntitlement(
  entitlement: RawRecord,
  packageId: string,
): RawRecord | undefined {
  const featureId = asString(entitlement["id"]);
  if (featureId === undefined) return undefined;

  return {
    entitlement_id: stiggEntitlementExternalId(packageId, featureId),
    feature_id: featureId,
    offering_id: packageId,
    value: stiggEntitlementValue(entitlement),
  };
}
