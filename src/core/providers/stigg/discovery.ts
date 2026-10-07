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
 * A static field list, plus whatever `metadata.*` keys one sample page reveals.
 *
 * Takes the list and the URL rather than hardcoding customers, because products
 * and features are sampled the same way. Offering, price and entitlement are
 * not: the first comes from two endpoints and the other two carry no metadata,
 * so all three are answered statically.
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
      // Every other object is declared here as empty rather than reaching a
      // catch-all: the compiler then asks this question again when a future
      // function adds an object, and until then `[]` is the truthful answer
      // instead of a plausible-looking list for an object this provider never
      // yields.
      case "agreement":
      case "subscription":
      case "agreementItem":
      case "agreementEntitlement":
      case "agreementDiscount":
      case "invoice":
      case "invoiceLine":
      case "payment":
        return [];
    }
  },
};
