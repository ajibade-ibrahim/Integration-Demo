/**
 * Stigg field discovery.
 *
 * Stigg publishes no describe or schema endpoint, so unlike HubSpot's
 * properties API or Salesforce's describe call there is nothing authoritative
 * to read. A purely static list would work, except it would miss the one thing
 * users most want to map: the free-form `metadata` object, whose keys differ
 * per environment.
 *
 * So: the known fields, unioned with the `metadata.*` keys sampled from one
 * small page of live data. The discovery service caches the answer for an hour,
 * so this costs one request per integration per hour.
 *
 * The static field lists live here rather than in a `fixtures.ts` because this
 * provider ships no fixture data (the user chose tests-only via msw), so a
 * separate module would hold two arrays and nothing else.
 *
 * The dispatch below is an exhaustive switch rather than a catch-all, and that
 * is deliberate. It names every object so the compiler asks the question when a
 * future function adds one; returning `[]` for the objects Stigg does not serve
 * is the honest answer, because offering customer fields for, say, a product
 * would be the "customer fields for everything" bug Stripe's switch documents.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asRecord, createProviderSession } from "../http";
import {
  customersUrl,
  featuresUrl,
  parseStiggPage,
  productsUrl,
  STIGG_DISCOVERY_SAMPLE,
  subscriptionsUrl,
} from "./api";
import { STIGG_SESSION_OPTIONS } from "./identity-handler";

export const STIGG_CUSTOMER_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "name", label: "Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
  { path: "archivedAt", label: "Archived at (ISO 8601; Stigg archives rather than deletes)", type: "datetime" },
  { path: "billingId", label: "Billing ID (the id in the connected billing provider — Stripe or Zuora)", type: "string" },
  { path: "billingCurrency", label: "Billing currency", type: "string" },
  { path: "timezone", label: "Time zone", type: "string" },
  { path: "language", label: "Language", type: "string" },
  { path: "couponId", label: "Coupon ID", type: "string" },
  // Synthesized by the handler from `integrations[]`, which no mapping path can
  // index — this is the `crossRef.stripe` source.
  { path: "stripe_customer_id", label: "Stripe customer ID (synthesized, crosswalk)", type: "string" },
];

/**
 * Contacts are entirely synthesized — Stigg has no contact resource — so every
 * path here is one this codebase invents. Labelled as such, so nobody hunts for
 * them in the Stigg API reference.
 */
export const STIGG_CONTACT_FIELDS: DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID (synthesized)", type: "string" },
  {
    path: "contact_name",
    label: "Contact name (customer name, or the email local part)",
    type: "string",
  },
  { path: "email", label: "Email", type: "string" },
  { path: "customer_id", label: "Customer ID (association)", type: "string" },
  { path: "customer_name", label: "Customer name", type: "string" },
];

/**
 * Products, as the catalog handler yields them. `active` is synthesized from
 * `status`; the rest are Stigg's own fields.
 */
export const STIGG_PRODUCT_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Product ID", type: "string" },
  { path: "displayName", label: "Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "status", label: "Status (PUBLISHED or ARCHIVED)", type: "string" },
  { path: "active", label: "Active (synthesized from status)", type: "boolean" },
  { path: "multipleSubscriptions", label: "Multiple subscriptions", type: "boolean" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
];

/**
 * A plan or an addon — the packages that become offerings.
 *
 * Static only. The records come from two endpoints, so sampling one would
 * advertise only half the keys; and the two shapes overlap enough that the
 * union is still honest.
 */
export const STIGG_OFFERING_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Package ID", type: "string" },
  { path: "displayName", label: "Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "productId", label: "Product ID (association)", type: "string" },
  { path: "status", label: "Status (PUBLISHED, DRAFT or ARCHIVED)", type: "string" },
  { path: "active", label: "Active (synthesized from status)", type: "boolean" },
  { path: "pricingType", label: "Pricing type (FREE, PAID or CUSTOM)", type: "string" },
  { path: "billingId", label: "Billing ID (the connected billing price id)", type: "string" },
  { path: "versionNumber", label: "Version number", type: "number" },
  { path: "isLatest", label: "Is latest version", type: "boolean" },
  { path: "parentPlanId", label: "Parent plan ID (plans only)", type: "string" },
  { path: "maxQuantity", label: "Maximum quantity (addons only)", type: "number" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
  { path: "defaultTrialConfig.duration", label: "Trial duration (plans only)", type: "number" },
  { path: "defaultTrialConfig.units", label: "Trial duration units (plans only)", type: "string" },
];

/**
 * Charges, as the catalog handler yields them. Every association and every
 * synthesized field is listed so the mapping editor can name it, but the raw
 * charge fields are Stigg's own.
 *
 * Static: charges carry no `metadata`, so there is nothing to sample.
 */
export const STIGG_PRICE_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Charge ID", type: "string" },
  { path: "offering_id", label: "Offering ID (association, synthesized)", type: "string" },
  { path: "price_name", label: "Name (synthesized)", type: "string" },
  { path: "amount_minor", label: "Amount (minor units; synthesized from price.amount)", type: "number" },
  {
    path: "billing_model",
    label: "Billing model (synthesized from billingModel)",
    type: "string",
  },
  { path: "interval", label: "Billing interval (synthesized)", type: "string" },
  { path: "interval_count", label: "Interval count (synthesized; always 1)", type: "number" },
  { path: "active", label: "Active (synthesized from the package)", type: "boolean" },
  { path: "billingPeriod", label: "Billing period (MONTHLY or ANNUALLY)", type: "string" },
  { path: "billingModel", label: "Billing model", type: "string" },
  { path: "billingCadence", label: "Billing cadence (RECURRING or ONE_OFF)", type: "string" },
  { path: "billingCountryCode", label: "Billing country code (when set)", type: "string" },
  { path: "price.amount", label: "Amount (major units, as Stigg states it)", type: "number" },
  { path: "price.currency", label: "Currency", type: "string" },
  { path: "featureId", label: "Metered feature ID (when the charge is for a feature)", type: "string" },
  { path: "blockSize", label: "Block size", type: "number" },
  { path: "minUnitQuantity", label: "Minimum unit quantity", type: "number" },
  { path: "maxUnitQuantity", label: "Maximum unit quantity", type: "number" },
  { path: "creditRate.amount", label: "Credit rate amount", type: "number" },
  { path: "creditRate.currencyId", label: "Credit currency ID", type: "string" },
  { path: "usedInSubscriptions", label: "Used in subscriptions", type: "boolean" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
];

/**
 * Feature definitions. `isMetered` is synthesized from `meterType`; the rest
 * are Stigg's own fields.
 */
export const STIGG_FEATURE_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Feature ID (the key applications gate on)", type: "string" },
  { path: "displayName", label: "Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "featureType", label: "Feature type (BOOLEAN, NUMBER or ENUM)", type: "string" },
  { path: "meterType", label: "Meter type (None, FLUCTUATING or INCREMENTAL)", type: "string" },
  { path: "isMetered", label: "Is metered (synthesized from meterType)", type: "boolean" },
  { path: "featureUnits", label: "Unit (singular)", type: "string" },
  { path: "featureUnitsPlural", label: "Unit (plural)", type: "string" },
  { path: "featureStatus", label: "Status", type: "string" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
];

/**
 * Feature entitlements on a package. Both ids and `value` are synthesized (see
 * `flattenEntitlement`); the raw configuration fields are Stigg's own.
 *
 * Static: entitlements carry no `metadata`, and one request per package means
 * there is no single page to sample.
 */
export const STIGG_ENTITLEMENT_FIELDS: DiscoveredFieldDef[] = [
  { path: "entitlement_id", label: "Entitlement ID (synthesized: package:feature)", type: "string" },
  { path: "feature_id", label: "Feature ID (association)", type: "string" },
  { path: "offering_id", label: "Offering ID (association, synthesized)", type: "string" },
  { path: "value", label: "Value (synthesized: limit, true, false or unlimited)", type: "string" },
  { path: "isGranted", label: "Granted", type: "boolean" },
  { path: "usageLimit", label: "Usage limit", type: "number" },
  { path: "hasUnlimitedUsage", label: "Unlimited usage", type: "boolean" },
  { path: "hasSoftLimit", label: "Soft limit", type: "boolean" },
  { path: "behavior", label: "Behavior (Increment or Override)", type: "string" },
  { path: "resetPeriod", label: "Reset period (YEAR, MONTH, WEEK, DAY or HOUR)", type: "string" },
  { path: "order", label: "Display order", type: "number" },
  { path: "description", label: "Description", type: "string" },
  { path: "displayNameOverride", label: "Display name override", type: "string" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
  { path: "updatedAt", label: "Updated at (ISO 8601)", type: "datetime" },
];

/**
 * Subscriptions, as the agreement handler yields them: the agreement's own
 * fields. Most are Stigg's; `agreement_name`, `agreement_type`, `status`,
 * `raw_status`, `end_date` and `currency` are synthesized (see
 * `flattenSubscription`), and `metadata.*` keys are sampled from one page.
 */
export const STIGG_AGREEMENT_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Subscription ID", type: "string" },
  {
    path: "agreement_name",
    label: "Name (synthesized: the plan, plus the resource when multi-resource)",
    type: "string",
  },
  { path: "agreement_type", label: "Agreement type (synthesized; always subscription)", type: "string" },
  { path: "status", label: "Status (synthesized: active, trialing, scheduled, draft, canceled, expired)", type: "string" },
  { path: "raw_status", label: "Status (Stigg's own word)", type: "string" },
  { path: "effective_date", label: "Effective date (synthesized: subscription start)", type: "datetime" },
  { path: "end_date", label: "End date (synthesized; set once canceled or expired)", type: "datetime" },
  { path: "currency", label: "Currency (synthesized from the first price)", type: "string" },
  { path: "cancelReason", label: "Cancel reason", type: "string" },
  { path: "resourceId", label: "Resource ID (when multi-resource)", type: "string" },
  { path: "payingCustomerId", label: "Paying customer ID (delegated billing)", type: "string" },
  { path: "billingId", label: "Billing ID (the id in the connected billing provider)", type: "string" },
  { path: "contractId", label: "Contract ID", type: "string" },
  { path: "pricingType", label: "Pricing type (FREE, PAID or CUSTOM)", type: "string" },
  { path: "createdAt", label: "Created at (ISO 8601)", type: "datetime" },
];

/**
 * The subscription-specific fields of the same record.
 *
 * Static: every path is synthesized from the subscription payload, and the raw
 * inputs (`currentBillingPeriodEnd`, `trialEndDate`, `cancellationDate`, …) are
 * listed alongside so a user can override the synthesis if they want to.
 */
export const STIGG_SUBSCRIPTION_FIELDS: DiscoveredFieldDef[] = [
  { path: "current_period_start", label: "Current period start (synthesized)", type: "datetime" },
  { path: "current_period_end", label: "Current period end (synthesized)", type: "datetime" },
  { path: "trial_ends_at", label: "Trial ends at (synthesized)", type: "datetime" },
  { path: "canceled_at", label: "Canceled at (synthesized; when cancellation was requested)", type: "datetime" },
  { path: "cancel_at", label: "Cancels at (synthesized; absent unless a cancellation is scheduled)", type: "datetime" },
  { path: "next_billing_at", label: "Next billing at (synthesized; absent when cancelling or ended)", type: "datetime" },
  { path: "cancel_at_period_end", label: "Cancels at period end (synthesized)", type: "boolean" },
  { path: "collection_method", label: "Collection method (synthesized: automatic, manual or none)", type: "string" },
  { path: "item_count", label: "Item count (synthesized: plan plus addons)", type: "number" },
  { path: "provider_metadata", label: "Provider metadata (JSON; synthesized)", type: "string" },
  { path: "currentBillingPeriodStart", label: "Current billing period start (ISO 8601)", type: "datetime" },
  { path: "currentBillingPeriodEnd", label: "Current billing period end (ISO 8601)", type: "datetime" },
  { path: "cancellationDate", label: "Cancellation date (ISO 8601)", type: "datetime" },
  { path: "effectiveEndDate", label: "Effective end date (ISO 8601)", type: "datetime" },
  { path: "paymentCollectionMethod", label: "Payment collection method (CHARGE, INVOICE or NONE)", type: "string" },
  { path: "pricingType", label: "Pricing type (FREE, PAID or CUSTOM)", type: "string" },
];

/**
 * Line items. Every path is synthesized; Stigg states no line ids and no line
 * money beyond the price override the handler folds into `unit_price_minor`.
 */
export const STIGG_AGREEMENT_ITEM_FIELDS: DiscoveredFieldDef[] = [
  { path: "item_id", label: "Line ID (synthesized: subscription:plan / :addon:<id>)", type: "string" },
  { path: "agreement_id", label: "Agreement ID (association, synthesized)", type: "string" },
  { path: "offering_id", label: "Offering ID (association, synthesized: the plan or addon)", type: "string" },
  { path: "item_type", label: "Line type (synthesized: plan or add_on)", type: "string" },
  { path: "position", label: "Position (synthesized: 0 is the plan)", type: "number" },
  { path: "quantity", label: "Quantity (addons only)", type: "number" },
  { path: "unit_price_minor", label: "Unit price (minor units; synthesized from the price override)", type: "number" },
];

/**
 * Discounts, from the subscription's inline `coupons`. Every path but the raw
 * coupon fields is synthesized; there is no window, so no `starts_at`/`ends_at`.
 */
export const STIGG_AGREEMENT_DISCOUNT_FIELDS: DiscoveredFieldDef[] = [
  { path: "discount_id", label: "Discount ID (synthesized: subscription:coupon:<id>)", type: "string" },
  { path: "agreement_id", label: "Agreement ID (association, synthesized)", type: "string" },
  { path: "coupon_id", label: "Coupon ID (provider)", type: "string" },
  { path: "coupon_name", label: "Coupon name", type: "string" },
  { path: "discount_kind", label: "Kind (synthesized: percentage or fixed_amount)", type: "string" },
  { path: "discount_status", label: "Status (synthesized: active, expired or removed)", type: "string" },
  { path: "percent_off", label: "Percent off", type: "number" },
  { path: "amount_off_minor", label: "Amount off (minor units; synthesized from amountsOff)", type: "number" },
  { path: "amountsOff", label: "Amounts off (raw, by currency)", type: "json" },
];

/**
 * A static field list, plus whatever `metadata.*` keys one sample page reveals.
 *
 * Takes the list and the URL rather than hardcoding customers, because
 * customers, products, features and subscriptions are all sampled the same way.
 * Offering, price, entitlement and the agreement children are not: the first
 * comes from two endpoints, the next two carry no metadata, and the children
 * are synthesized rather than sampled.
 */
async function withMetadataKeys(
  ctx: Omit<HandlerContext, "requestedSourcePaths">,
  fields: readonly DiscoveredFieldDef[],
  url: string,
): Promise<readonly DiscoveredFieldDef[]> {
  const session = createProviderSession(ctx, "Stigg", STIGG_SESSION_OPTIONS);
  const body = parseStiggPage(await session.getJson(url));

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const key of Object.keys(asRecord(record["metadata"]) ?? {})) {
      metadataKeys.add(key);
    }
  }

  return [
    ...fields,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Metadata — ${key}`,
      type: "string",
    })),
  ];
}

export const stiggFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject,
  ): Promise<readonly DiscoveredFieldDef[]> {
    // Contacts are entirely synthesized by the identity handler, so their shape
    // is known statically and needs no request.
    if (object === "contact") return [...STIGG_CONTACT_FIELDS];

    switch (object) {
      case "customer":
        return withMetadataKeys(
          ctx,
          STIGG_CUSTOMER_FIELDS,
          customersUrl(STIGG_DISCOVERY_SAMPLE),
        );
      case "product":
        return withMetadataKeys(
          ctx,
          STIGG_PRODUCT_FIELDS,
          productsUrl(STIGG_DISCOVERY_SAMPLE),
        );
      case "feature":
        return withMetadataKeys(
          ctx,
          STIGG_FEATURE_FIELDS,
          featuresUrl(STIGG_DISCOVERY_SAMPLE),
        );
      // Offering, price and entitlement are static: the first is assembled
      // from two endpoints, and the other two carry no `metadata`.
      case "offering":
        return [...STIGG_OFFERING_FIELDS];
      case "price":
        return [...STIGG_PRICE_FIELDS];
      case "entitlement":
        return [...STIGG_ENTITLEMENT_FIELDS];
      // The agreement is the subscription record, so its metadata keys are
      // sampled from the subscription list like a customer's are. The other
      // agreement objects are synthesized in full and stated statically.
      case "agreement":
        return withMetadataKeys(
          ctx,
          STIGG_AGREEMENT_FIELDS,
          subscriptionsUrl(STIGG_DISCOVERY_SAMPLE),
        );
      case "subscription":
        return [...STIGG_SUBSCRIPTION_FIELDS];
      case "agreementItem":
        return [...STIGG_AGREEMENT_ITEM_FIELDS];
      case "agreementDiscount":
        return [...STIGG_AGREEMENT_DISCOUNT_FIELDS];
      // `agreementEntitlement` is deliberately built on no endpoint: the
      // subscription payload carries no effective entitlement values and the
      // customer-level state folds every subscription and the promotional
      // grants together. See `agreement-handler.ts` for the full reason. `[]` is
      // the truthful answer here, not a list for an object this provider never
      // yields.
      case "agreementEntitlement":
      // Every other object is declared here as empty rather than reaching a
      // catch-all: the compiler then asks this question again when a future
      // function adds an object, and until then `[]` is the truthful answer
      // instead of a plausible-looking list for an object this provider never
      // yields.
      case "invoice":
      case "invoiceLine":
      case "payment":
        return [];
    }
  },
};
