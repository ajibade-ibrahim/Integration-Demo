/**
 * Stripe's static field definitions for the mapping editor.
 *
 * Unlike the mock and Metrifox modules of the same name, there is no fixture
 * *data* here. Stripe's demo data lives in `scripts/stripe-sandbox-fixtures.json`
 * and is created in a real sandbox by the Stripe CLI, so there is nothing for an
 * in-app fake to serve.
 *
 * Stripe publishes no describe or schema endpoint, so the fixed part of the
 * schema is declared here. Discovery unions this with the `metadata.*` keys it
 * samples from live data — see discovery.ts.
 */

import type { DiscoveredFieldDef } from "../../types/registry";

export const STRIPE_CUSTOMER_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "name", label: "Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "description", label: "Description", type: "string" },
  {
    path: "created_at",
    label: "Created at (ISO 8601, synthesized from created)",
    type: "datetime",
  },
  // Offered, but labelled, rather than hidden. A user who reaches for the field
  // named in Stripe's own docs would otherwise map it, see an empty Create date
  // column, and have nothing to explain it: epoch seconds do not survive the
  // record writer's date parse.
  {
    path: "created",
    label: "Created (Unix epoch seconds — map created_at instead)",
    type: "number",
  },
  { path: "currency", label: "Currency", type: "string" },
  { path: "balance", label: "Account balance", type: "number" },
  { path: "delinquent", label: "Delinquent", type: "boolean" },
  { path: "invoice_prefix", label: "Invoice prefix", type: "string" },
  { path: "tax_exempt", label: "Tax exempt", type: "string" },
  { path: "address.city", label: "Address — city", type: "string" },
  { path: "address.state", label: "Address — state", type: "string" },
  { path: "address.postal_code", label: "Address — postal code", type: "string" },
  { path: "address.country", label: "Address — country", type: "string" },
];

/**
 * Contacts are entirely synthesized — Stripe has no contact resource — so every
 * path here is one this codebase invents. Labelled as such, so nobody hunts for
 * them in the Stripe API reference.
 */
export const STRIPE_CONTACT_FIELDS: DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID (synthesized)", type: "string" },
  {
    path: "contact_name",
    label: "Contact name (customer name, or the email local part)",
    type: "string",
  },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "customer_id", label: "Customer ID (association)", type: "string" },
  { path: "customer_name", label: "Customer name", type: "string" },
];

export const STRIPE_PRODUCT_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Product ID", type: "string" },
  { path: "name", label: "Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "active", label: "Active", type: "boolean" },
  {
    path: "created_at",
    label: "Created at (ISO 8601, synthesized from created)",
    type: "datetime",
  },
  // Offered and labelled rather than hidden, for the reason given on the
  // customer fields above: a user who maps Stripe's own `created` should be
  // told why the column comes out empty, not left to discover it.
  {
    path: "created",
    label: "Created (Unix epoch seconds — map created_at instead)",
    type: "number",
  },
  { path: "unit_label", label: "Unit label", type: "string" },
  { path: "url", label: "Product URL", type: "string" },
  { path: "statement_descriptor", label: "Statement descriptor", type: "string" },
];

/**
 * Offering fields — the subset of a product's that an offering record carries.
 *
 * Every path here exists on the synthesized offering the catalog handler builds
 * from a product, which is exactly the five keys it writes. A Stripe product has
 * one offering with the same id, so the offering record is not a second read of
 * the API but a second *view* of the same row.
 *
 * Deliberately not `STRIPE_PRODUCT_FIELDS`, which discovery would otherwise
 * reuse for the shape the two targets share. The product record is the raw
 * payload plus a synthesized date, so it carries `created_at`, `unit_label`,
 * `url`, `statement_descriptor` and the account's metadata keys. The offering
 * record is built key by key and carries none of them — and offering a path that
 * resolves to nothing on every row is the failure the shipped default mapping is
 * checked against, one object over.
 */
export const STRIPE_OFFERING_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Offering ID (the product's own id)", type: "string" },
  { path: "name", label: "Name (from the product)", type: "string" },
  { path: "description", label: "Description (from the product)", type: "string" },
  { path: "active", label: "Active (from the product)", type: "boolean" },
  {
    path: "product_id",
    label: "Product ID (synthesized; the offering's own id)",
    type: "string",
  },
];

/**
 * Price fields, including the three the handler synthesizes.
 *
 * `offering_name`, `interval` and `interval_count` do not exist in Stripe's
 * response — see `flattenPrice`. They are listed first because they are the ones
 * the default mapping uses and the ones a user wants: the raw `recurring.interval`
 * below is offered for completeness, but mapping it works only because `readPath`
 * walks dots, and it is null for one-time prices where the synthesized field says
 * `one_time`.
 */
export const STRIPE_PRICE_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Price ID", type: "string" },
  {
    path: "offering_name",
    label: "Display name (synthesized from nickname or amount)",
    type: "string",
  },
  {
    path: "interval",
    label: "Billing interval (synthesized; one_time when not recurring)",
    type: "string",
  },
  {
    path: "interval_count",
    label: "Interval count (synthesized; 1 when not recurring)",
    type: "number",
  },
  { path: "product_id", label: "Product ID (synthesized)", type: "string" },
  { path: "nickname", label: "Nickname (often empty)", type: "string" },
  { path: "unit_amount", label: "Unit amount (minor units)", type: "number" },
  { path: "currency", label: "Currency", type: "string" },
  { path: "active", label: "Active", type: "boolean" },
  { path: "type", label: "Type (one_time or recurring)", type: "string" },
  { path: "billing_scheme", label: "Billing scheme", type: "string" },
  { path: "recurring.interval", label: "Recurring interval (raw)", type: "string" },
  {
    path: "recurring.interval_count",
    label: "Recurring interval count (raw)",
    type: "number",
  },
  {
    path: "recurring.usage_type",
    label: "Usage type (licensed or metered)",
    type: "string",
  },
  {
    path: "created_at",
    label: "Created at (ISO 8601, synthesized from created)",
    type: "datetime",
  },
];

/**
 * Feature definition fields — the reusable `feat_…` definitions.
 *
 * Synthesized paths first: `feature_name` and `lookup_key` are lifted to the top
 * level by `flattenFeatureDefinition`, while the nested `entitlement_feature.*`
 * paths are offered raw for anyone who wants Stripe's own shape. There is no
 * `offering_id` here — a definition hangs off nothing.
 */
export const STRIPE_FEATURE_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Feature ID (feat_…)", type: "string" },
  {
    path: "feature_name",
    label: "Feature name (synthesized from entitlement_feature.name)",
    type: "string",
  },
  {
    path: "lookup_key",
    label: "Lookup key — what code gates on (synthesized)",
    type: "string",
  },
  {
    path: "entitlement_feature.name",
    label: "Feature name (raw)",
    type: "string",
  },
  {
    path: "entitlement_feature.lookup_key",
    label: "Lookup key (raw)",
    type: "string",
  },
];

/**
 * Entitlement fields — one offering's attachment of one feature.
 *
 * The offering id is injected by the handler from the URL it requested — it
 * does not appear in the Stripe response payload at all. There is deliberately
 * no value of any kind: Stripe states no limit on an attachment, and an
 * entitlement's useful columns are derived from the two ids.
 */
export const STRIPE_ENTITLEMENT_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Attachment ID (prodft_…)", type: "string" },
  {
    path: "feature_id",
    label: "Feature ID (feat_…, synthesized)",
    type: "string",
  },
  {
    path: "offering_id",
    label: "Offering ID (synthesized from the request URL, not the payload)",
    type: "string",
  },
  { path: "livemode", label: "Live mode", type: "boolean" },
];

/**
 * Agreement fields — the shared commercial node, read from a subscription.
 *
 * Synthesized paths first, as in `STRIPE_PRICE_FIELDS`, because they are the
 * ones a user should reach for: `agreement_name` exists because Stripe gives a
 * subscription no name, and `status` here is already translated into our
 * vocabulary rather than Stripe's eight.
 */
export const STRIPE_AGREEMENT_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Subscription ID", type: "string" },
  {
    path: "agreement_name",
    label: "Name (synthesized from the price nickname or amount)",
    type: "string",
  },
  {
    path: "agreement_type",
    label: "Agreement type (synthesized; always subscription here)",
    type: "string",
  },
  {
    path: "status",
    label: "Status (translated to draft/trialing/active/past_due/paused/canceled)",
    type: "string",
  },
  {
    path: "customer_id",
    label: "Customer ID (synthesized)",
    type: "string",
  },
  {
    path: "offering_id",
    label: "Offering ID — the product behind the first item's price (synthesized)",
    type: "string",
  },
  {
    path: "effective_date",
    label: "Effective date (ISO 8601, synthesized from start_date)",
    type: "datetime",
  },
  {
    path: "ended_at",
    label: "Ended at (ISO 8601, synthesized from ended_at)",
    type: "datetime",
  },
  { path: "currency", label: "Currency", type: "string" },
  {
    path: "raw_status",
    label: "Stripe's own status — map `status` instead unless you need the original",
    type: "string",
  },
  {
    path: "provider_metadata",
    label: "Stripe metadata (JSON, synthesized from metadata)",
    type: "string",
  },
  { path: "description", label: "Description", type: "string" },
  {
    path: "start_date",
    label: "Start date (Unix epoch seconds — map effective_date instead)",
    type: "number",
  },
];

/**
 * Subscription fields — the recurring-billing detail.
 *
 * No name here, deliberately: this row extends one agreement, which has one.
 * The period dates are the reason the object exists, so they lead.
 */
export const STRIPE_SUBSCRIPTION_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Subscription ID", type: "string" },
  {
    path: "current_period_start",
    label: "Current period start (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "current_period_end",
    label: "Current period end (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "trial_ends_at",
    label: "Trial ends at (ISO 8601, synthesized from trial_end)",
    type: "datetime",
  },
  {
    path: "trial_starts_at",
    label: "Trial starts at (ISO 8601, synthesized from trial_start)",
    type: "datetime",
  },
  {
    path: "canceled_at",
    label: "Canceled at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "cancel_at",
    label: "Cancels at (ISO 8601, synthesized from cancel_at)",
    type: "datetime",
  },
  {
    path: "cancel_at_period_end",
    label: "Cancels at period end",
    type: "boolean",
  },
  {
    path: "billing_period",
    label: "Primary line's billing period (synthesized)",
    type: "string",
  },
  {
    path: "billing_period_count",
    label: "Primary line's billing period count (synthesized)",
    type: "number",
  },
  {
    path: "item_count",
    label: "Number of priced items (synthesized; only the first is linked)",
    type: "number",
  },
  {
    path: "quantity",
    label: "Quantity on the first item (synthesized)",
    type: "number",
  },
  {
    path: "collection_method",
    label: "Collection method (translated to automatic or manual)",
    type: "string",
  },
  {
    path: "provider_metadata",
    label: "Stripe metadata for the subscription (JSON, synthesized)",
    type: "string",
  },
  {
    path: "items.data.0.price.unit_amount",
    label: "First item's unit amount (minor units)",
    type: "number",
  },
  {
    path: "items.data.0.price.nickname",
    label: "First item's price nickname (often empty)",
    type: "string",
  },
];

/**
 * Line-item fields — one priced line on a subscription.
 *
 * The three synthesized paths lead, as they do for offerings and features, and
 * the raw ones follow labelled as such. Two of them are worth reading the
 * labels on before mapping.
 *
 * `subscription` is the item's own field and is offered, but it is **not** how
 * the line finds its agreement: the engine uses the synthesized `agreement_id`,
 * injected from the subscription this item was actually fetched from. They
 * agree today. Mapping the raw one anyway would work right up until they did
 * not, and this is the writer that deletes — a line that reassigned itself
 * would take its former siblings with it.
 *
 * `price.recurring.usage_type` is what `item_type` is read from, offered raw
 * for anyone who wants Stripe's own word rather than our three-member
 * vocabulary — the same courtesy `raw_status` extends on the agreement.
 */
export const STRIPE_AGREEMENT_ITEM_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Line item ID", type: "string" },
  {
    path: "position",
    label: "Position in the item list (synthesized; 0 is the linked line)",
    type: "number",
  },
  {
    path: "item_type",
    label: "Line type (synthesized; 'usage' for a metered price, else unset)",
    type: "string",
  },
  {
    path: "billing_model",
    label:
      "Billing model (synthesized; usage_based/tiered/per_unit/one_time, else unset)",
    type: "string",
  },
  {
    path: "provider_metadata",
    label: "Stripe metadata for the line (JSON, synthesized)",
    type: "string",
  },
  {
    path: "agreement_id",
    label: "Subscription ID (synthesized from the fetch, not the record)",
    type: "string",
  },
  {
    path: "price_id",
    label: "Price ID (synthesized from price.id — which price was sold)",
    type: "string",
  },
  {
    path: "offering_id",
    label: "Offering ID (synthesized from price.product — what was sold)",
    type: "string",
  },
  { path: "quantity", label: "Quantity", type: "number" },
  { path: "price.id", label: "Price ID (raw)", type: "string" },
  {
    path: "price.unit_amount",
    label: "Unit amount, minor units (raw)",
    type: "number",
  },
  { path: "price.currency", label: "Currency (raw)", type: "string" },
  {
    path: "price.recurring.usage_type",
    label: "Usage type — licensed or metered (raw)",
    type: "string",
  },
  {
    path: "subscription",
    label: "Subscription ID (raw — prefer agreement_id)",
    type: "string",
  },
  { path: "created", label: "Created (Unix epoch seconds, raw)", type: "number" },
];
