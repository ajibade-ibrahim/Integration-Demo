/**
 * Stripe field discovery.
 *
 * Stripe publishes no describe or schema endpoint, so unlike HubSpot's
 * properties API or Salesforce's describe call there is nothing authoritative
 * to read. A purely static list — the mock provider's approach — would work,
 * except it would miss the one thing users most want to map: the free-form
 * `metadata` object, whose keys differ per account.
 *
 * So: the known fields, unioned with the `metadata.*` keys sampled from one
 * small page of live data. The discovery service caches the answer for an hour,
 * so this costs one request per integration per hour.
 *
 * The dispatch below is an exhaustive switch rather than a default branch, and
 * that is deliberate. It used to read "contacts are static, everything else
 * samples customers", which was true while customer and contact were the only
 * objects — and would have quietly offered *customer* fields for products the
 * moment a second function existed. A switch that names every object makes the
 * compiler ask the question when the next one is added.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asRecord, createProviderSession, type ProviderSession } from "../http";
import {
  entitlementFeaturesUrl,
  invoiceLines,
  listUrl,
  parseListPage,
  subscriptionItems,
  STRIPE_DISCOVERY_SAMPLE,
  type StripeResource,
} from "./api";
import {
  STRIPE_AGREEMENT_FIELDS,
  STRIPE_AGREEMENT_ITEM_FIELDS,
  STRIPE_CONTACT_FIELDS,
  STRIPE_CUSTOMER_FIELDS,
  STRIPE_ENTITLEMENT_FIELDS,
  STRIPE_FEATURE_FIELDS,
  STRIPE_INVOICE_FIELDS,
  STRIPE_INVOICE_LINE_FIELDS,
  STRIPE_OFFERING_FIELDS,
  STRIPE_PAYMENT_FIELDS,
  STRIPE_PRICE_FIELDS,
  STRIPE_PRODUCT_FIELDS,
  STRIPE_SUBSCRIPTION_FIELDS,
} from "./fixtures";
import { STRIPE_SESSION_OPTIONS } from "./identity-handler";

/**
 * The static fields, plus whatever `metadata.*` keys one sample page reveals.
 *
 * Every Stripe resource carries a `metadata` object with account-specific keys,
 * so the sampling is worth doing for each of them and not just for customers.
 */
async function withMetadataKeys(
  session: ProviderSession,
  resource: StripeResource,
  base: readonly DiscoveredFieldDef[]
): Promise<readonly DiscoveredFieldDef[]> {
  const body = parseListPage(
    await session.getJson(listUrl(resource, STRIPE_DISCOVERY_SAMPLE))
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const key of Object.keys(asRecord(record["metadata"]) ?? {})) {
      metadataKeys.add(key);
    }
  }

  return [
    ...base,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Metadata — ${key}`,
      type: "string",
    })),
  ];
}

/**
 * The product-feature fields, plus whatever metadata keys the account's feature
 * *definitions* reveal.
 *
 * Its own function rather than a `withMetadataKeys` call, for two reasons that
 * are both about which endpoint gets asked.
 *
 * A `ProductFeature` attachment carries no `metadata` of its own — it is an id,
 * a `livemode` flag and the nested definition — so sampling attachments would
 * find nothing. The account-specific keys live on the `Feature`, one level down,
 * and therefore surface as `entitlement_feature.metadata.*`.
 *
 * And the attachments are only reachable per product, so sampling them would
 * mean fanning out over products to populate a dropdown. The definitions
 * endpoint is flat, so this costs the same single request that every other
 * object's discovery costs. An account with definitions but no attachments
 * still gets a useful field list, which is the right answer for a mapping
 * editor: the rules are being written before the sync that would use them.
 */
async function withFeatureMetadataKeys(
  session: ProviderSession,
  base: readonly DiscoveredFieldDef[]
): Promise<readonly DiscoveredFieldDef[]> {
  const body = parseListPage(
    await session.getJson(entitlementFeaturesUrl(STRIPE_DISCOVERY_SAMPLE))
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const key of Object.keys(asRecord(record["metadata"]) ?? {})) {
      metadataKeys.add(key);
    }
  }

  return [
    ...base,
    ...[...metadataKeys].sort().map((key) => ({
      // Prefixed with the nested path the record actually carries. A bare
      // `metadata.<key>` here would offer a path that resolves to nothing on
      // every feature record, because the attachment has no metadata object.
      path: `entitlement_feature.metadata.${key}`,
      label: `Feature metadata — ${key}`,
      type: "string",
    })),
  ];
}

/**
 * The line-item fields, plus the metadata keys the account's items carry.
 *
 * Sampled from `/v1/subscriptions` rather than `/v1/subscription_items`, and
 * not to save a request: the items endpoint requires a `subscription`
 * parameter, so asking it anything means first listing subscriptions to pick
 * one — two requests to sample the items of a single arbitrary subscription.
 * Reading the inlined lists off a page of subscriptions samples many for one
 * request, which is a better dropdown as well as a cheaper one.
 *
 * Only the inlined items are seen, so a mapping editor on an account whose
 * eleventh line carries a unique metadata key will not offer it. That is the
 * right trade for a dropdown — it is a suggestion list, and a user who knows
 * the key can still type the path. The sync itself completes the list.
 */
async function withItemMetadataKeys(
  session: ProviderSession,
  base: readonly DiscoveredFieldDef[]
): Promise<readonly DiscoveredFieldDef[]> {
  const body = parseListPage(
    await session.getJson(listUrl("subscriptions", STRIPE_DISCOVERY_SAMPLE))
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const item of subscriptionItems(record)) {
      for (const key of Object.keys(asRecord(item["metadata"]) ?? {})) {
        metadataKeys.add(key);
      }
    }
  }

  return [
    ...base,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Line metadata — ${key}`,
      type: "string",
    })),
  ];
}

/**
 * The invoice-line fields, plus the metadata keys the account's lines carry.
 *
 * `withItemMetadataKeys`' reasoning, one function over: the lines are only
 * reachable inside an invoice, so a page of invoices samples many lines for one
 * request rather than fanning out per invoice.
 */
async function withInvoiceLineMetadataKeys(
  session: ProviderSession,
  base: readonly DiscoveredFieldDef[]
): Promise<readonly DiscoveredFieldDef[]> {
  const body = parseListPage(
    await session.getJson(listUrl("invoices", STRIPE_DISCOVERY_SAMPLE))
  );

  const metadataKeys = new Set<string>();
  for (const record of body.records) {
    for (const line of invoiceLines(record)) {
      for (const key of Object.keys(asRecord(line["metadata"]) ?? {})) {
        metadataKeys.add(key);
      }
    }
  }

  return [
    ...base,
    ...[...metadataKeys].sort().map((key) => ({
      path: `metadata.${key}`,
      label: `Invoice line metadata — ${key}`,
      type: "string",
    })),
  ];
}

export const stripeFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    // Contacts are entirely synthesized by the identity handler, so their shape
    // is known statically and needs no request.
    if (object === "contact") return [...STRIPE_CONTACT_FIELDS];

    const session = createProviderSession(ctx, "Stripe", STRIPE_SESSION_OPTIONS);

    switch (object) {
      case "customer":
        return withMetadataKeys(session, "customers", STRIPE_CUSTOMER_FIELDS);
      case "product":
        return withMetadataKeys(session, "products", STRIPE_PRODUCT_FIELDS);
      // Static, and no request: the offering record is built key by key from a
      // product the handler listed, so its shape is known here exactly as
      // `contact`'s is — and it carries no metadata, which is why nothing is
      // sampled from the products endpoint for it.
      case "offering":
        return [...STRIPE_OFFERING_FIELDS];
      // The prices endpoint, and sampled: unlike the offering, a price record is
      // the raw payload with the synthesized fields spread over it, so it keeps
      // whatever metadata the account put on its prices.
      case "price":
        return withMetadataKeys(session, "prices", STRIPE_PRICE_FIELDS);
      // The one object whose metadata lives on a nested record, read from the
      // flat definitions endpoint rather than from the attachments themselves.
      case "feature":
        return withFeatureMetadataKeys(session, STRIPE_FEATURE_FIELDS);
      // Static, and no request: the entitlement record is built from the
      // attachment's own id and two synthesised ids, and Stripe states nothing
      // else on it — so there is nothing to sample.
      case "entitlement":
        return [...STRIPE_ENTITLEMENT_FIELDS];
      // Both halves of an agreement are read from the same endpoint, because
      // they are two halves of one Stripe record. Only the field list differs:
      // the shared node's fields against the recurring detail's.
      case "agreement":
        return withMetadataKeys(
          session,
          "subscriptions",
          STRIPE_AGREEMENT_FIELDS
        );
      case "subscription":
        return withMetadataKeys(
          session,
          "subscriptions",
          STRIPE_SUBSCRIPTION_FIELDS
        );
      // The third object off that same endpoint, and the one whose records are
      // nested inside it rather than being it — so its metadata is read from
      // `items.data[].metadata` rather than from the subscription's own.
      case "agreementItem":
        return withItemMetadataKeys(session, STRIPE_AGREEMENT_ITEM_FIELDS);
      // Stripe has no source for either of these: it states no per-subscription
      // entitlement list and no discount attachment on a subscription. An empty
      // list is the honest answer; offering fields here would be the
      // "customer fields for everything" bug this switch was written to stop.
      case "agreementEntitlement":
      case "agreementDiscount":
        return [];
      // An invoice's metadata is its own, so it is sampled from the invoices
      // endpoint like every other top-level object's.
      case "invoice":
        return withMetadataKeys(session, "invoices", STRIPE_INVOICE_FIELDS);
      // Nested inside an invoice rather than being one, so its metadata comes
      // from `lines.data[].metadata` — the `agreementItem` shape one function
      // over.
      case "invoiceLine":
        return withInvoiceLineMetadataKeys(session, STRIPE_INVOICE_LINE_FIELDS);
      // Static, and no request: a payment row is a charge or a refund plus
      // synthesized ids, and its own `metadata` is not worth a separate
      // request when the mapping editor's suggestion list is the only reader.
      case "payment":
        return [...STRIPE_PAYMENT_FIELDS];
    }
  },
};
