/**
 * Chargebee field discovery.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";

export const CHARGEBEE_CUSTOMER_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "first_name", label: "First Name", type: "string" },
  { path: "last_name", label: "Last Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "company", label: "Company Name", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "created_at", label: "Created Date", type: "date" },
  { path: "billing_address.first_name", label: "Billing First Name", type: "string" },
  { path: "billing_address.last_name", label: "Billing Last Name", type: "string" },
  { path: "billing_address.email", label: "Billing Email", type: "string" },
  { path: "billing_address.phone", label: "Billing Phone", type: "string" },
  { path: "billing_address.company", label: "Billing Company", type: "string" },
  { path: "billing_address.line1", label: "Billing Address Line 1", type: "string" },
  { path: "billing_address.city", label: "Billing City", type: "string" },
  { path: "billing_address.state", label: "Billing State", type: "string" },
  { path: "billing_address.country", label: "Billing Country", type: "string" },
  { path: "billing_address.zip", label: "Billing Zip", type: "string" },
];

export const CHARGEBEE_CONTACT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID", type: "string" },
  { path: "contact_name", label: "Contact Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "customer_id", label: "Customer ID", type: "string" },
  { path: "customer_name", label: "Customer Name", type: "string" },
];

export const CHARGEBEE_PRODUCT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item Family ID", type: "string" },
  { path: "name", label: "Family Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

export const CHARGEBEE_OFFERING_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item ID", type: "string" },
  { path: "name", label: "Item Name", type: "string" },
  { path: "description", label: "Description", type: "string" },
  { path: "type", label: "Item Type", type: "string" },
  { path: "item_family_id", label: "Item Family ID", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

export const CHARGEBEE_PRICE_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item Price ID", type: "string" },
  { path: "price_name", label: "Price Name", type: "string" },
  { path: "item_id", label: "Item ID", type: "string" },
  { path: "price", label: "Price Amount", type: "number" },
  { path: "currency_code", label: "Currency Code", type: "string" },
  { path: "period", label: "Period Count", type: "number" },
  { path: "period_unit", label: "Period Unit", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

/**
 * A feature *definition* — Chargebee's `/features` object.
 *
 * `metered` and `unit` live here, on the definition; the Item Entitlement that
 * attaches the feature to an item does not repeat them. `type` is Chargebee's
 * own ("switch", "range") and has no column of ours, so it is offered for a
 * custom field.
 */
export const CHARGEBEE_FEATURE_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Feature ID", type: "string" },
  { path: "name", label: "Feature Name", type: "string" },
  { path: "metered", label: "Metered", type: "boolean" },
  { path: "unit", label: "Unit", type: "string" },
  { path: "type", label: "Feature Type", type: "string" },
  { path: "status", label: "Status", type: "string" },
];

/**
 * An item entitlement: one feature attached to one item.
 *
 * `name` is the *entitlement level's* label ("Maximum", "Available"), not the
 * feature's name — that is `feature_name` on the definition. `value` is the
 * level's raw value ("300", "true").
 */
export const CHARGEBEE_ENTITLEMENT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Item Entitlement ID", type: "string" },
  { path: "feature_id", label: "Feature ID", type: "string" },
  { path: "feature_name", label: "Feature Name", type: "string" },
  { path: "item_id", label: "Item ID (offering)", type: "string" },
  { path: "item_type", label: "Item Type", type: "string" },
  { path: "value", label: "Entitlement Value", type: "string" },
  { path: "name", label: "Entitlement Level", type: "string" },
];

/**
 * Agreement fields — the shared commercial node, read from a subscription.
 *
 * The synthesized paths lead, as they do for Stripe, because they are the ones
 * a user should reach for: `agreement_name` exists because Chargebee gives a
 * subscription no name, and `status` is already translated into our vocabulary
 * rather than Chargebee's seven.
 */
export const CHARGEBEE_AGREEMENT_FIELDS: readonly DiscoveredFieldDef[] = [
  { path: "id", label: "Subscription ID", type: "string" },
  {
    path: "agreement_name",
    label: "Name (synthesized from the plan line's item price id)",
    type: "string",
  },
  {
    path: "agreement_type",
    label: "Agreement type (synthesized; always subscription here)",
    type: "string",
  },
  {
    path: "status",
    label:
      "Status (translated to draft/trialing/active/past_due/paused/canceled/scheduled)",
    type: "string",
  },
  {
    path: "chargebee_status",
    label:
      "Chargebee's own status — map `status` instead unless you need the original",
    type: "string",
  },
  { path: "customer_id", label: "Customer ID", type: "string" },
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
    path: "effective_date",
    label: "Effective date (ISO 8601, synthesized from started_at)",
    type: "datetime",
  },
  {
    path: "ended_at",
    label: "Ended at (ISO 8601, synthesized; only when cancelled)",
    type: "datetime",
  },
  { path: "currency_code", label: "Currency code", type: "string" },
  {
    path: "provider_metadata",
    label: "Chargebee meta_data (JSON, synthesized)",
    type: "string",
  },
];

/** Subscription fields — the recurring-billing detail, off the same record. */
export const CHARGEBEE_SUBSCRIPTION_FIELDS: readonly DiscoveredFieldDef[] = [
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
    path: "next_billing_at",
    label: "Next billing at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "trial_starts_at",
    label: "Trial starts at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "trial_ends_at",
    label: "Trial ends at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "canceled_at",
    label: "Canceled at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "cancel_at",
    label: "Cancels at (ISO 8601, synthesized)",
    type: "datetime",
  },
  {
    path: "cancel_at_period_end",
    label: "Cancels at period end (synthesized; from non_renewing status)",
    type: "boolean",
  },
  {
    path: "billing_period",
    label: "Billing period unit (synthesized)",
    type: "string",
  },
  {
    path: "billing_period_count",
    label: "Billing period count (synthesized)",
    type: "number",
  },
  {
    path: "collection_method",
    label: "Collection method (translated to automatic or manual)",
    type: "string",
  },
  {
    path: "item_count",
    label: "Number of subscription items (synthesized)",
    type: "number",
  },
  {
    path: "provider_metadata",
    label: "Chargebee meta_data (JSON, synthesized)",
    type: "string",
  },
];

/** Line-item fields — one inline `subscription_item`. */
export const CHARGEBEE_AGREEMENT_ITEM_FIELDS: readonly DiscoveredFieldDef[] = [
  {
    path: "item_type",
    label: "Line type (synthesized; addon → add_on)",
    type: "string",
  },
  {
    path: "price_id",
    label: "Item price id (synthesized from item_price_id)",
    type: "string",
  },
  {
    path: "position",
    label: "Position in the item list (synthesized)",
    type: "number",
  },
  {
    path: "agreement_id",
    label: "Subscription ID (synthesized from the fetch, not the record)",
    type: "string",
  },
  { path: "quantity", label: "Quantity", type: "number" },
  { path: "unit_price", label: "Unit price, minor units", type: "number" },
  { path: "free_quantity", label: "Free quantity", type: "number" },
  { path: "billing_cycles", label: "Billing cycles", type: "number" },
  { path: "amount", label: "Line amount, minor units", type: "number" },
  { path: "item_price_id", label: "Item price id (raw)", type: "string" },
];

/**
 * Effective-entitlement fields — one subscription entitlement.
 *
 * `name` is the entitlement *level* label ("Maximum", "Available"), not the
 * feature's name (which is `feature_name`), exactly as on the catalog
 * entitlement list. The agreement link is injected, so it is offered
 * synthesized rather than as the payload's own `subscription_id`.
 */
export const CHARGEBEE_AGREEMENT_ENTITLEMENT_FIELDS: readonly DiscoveredFieldDef[] =
  [
    { path: "feature_id", label: "Feature ID", type: "string" },
    { path: "feature_name", label: "Feature Name", type: "string" },
    { path: "value", label: "Entitlement Value", type: "string" },
    { path: "name", label: "Entitlement Level", type: "string" },
    { path: "is_overridden", label: "Overrides the catalog value", type: "boolean" },
    { path: "is_enabled", label: "Feature enabled", type: "boolean" },
    {
      path: "agreement_id",
      label: "Subscription ID (synthesized from the fetch, not the record)",
      type: "string",
    },
  ];

/** Discount fields — one discount attached to a subscription. */
export const CHARGEBEE_AGREEMENT_DISCOUNT_FIELDS: readonly DiscoveredFieldDef[] =
  [
    { path: "discount_id", label: "Discount ID (synthesized)", type: "string" },
    { path: "coupon_id", label: "Coupon ID", type: "string" },
    { path: "invoice_name", label: "Invoice label", type: "string" },
    {
      path: "discount_kind",
      label: "Kind (synthesized from type)",
      type: "string",
    },
    { path: "percentage", label: "Percentage off", type: "number" },
    { path: "amount", label: "Amount off, minor units", type: "number" },
    {
      path: "discount_status",
      label: "Status (synthesized from duration_type)",
      type: "string",
    },
    {
      path: "starts_at",
      label: "Starts at (ISO 8601, synthesized from created_at)",
      type: "datetime",
    },
    {
      path: "ends_at",
      label: "Ends at (ISO 8601, synthesized from apply_till)",
      type: "datetime",
    },
    { path: "duration_type", label: "Duration type (raw)", type: "string" },
    { path: "apply_on", label: "Applies to (raw)", type: "string" },
    { path: "item_price_id", label: "Item price ID (raw)", type: "string" },
    {
      path: "agreement_id",
      label: "Subscription ID (synthesized from the fetch, not the record)",
      type: "string",
    },
  ];

export const chargebeeFieldDiscovery: FieldDiscovery = {
  async discover(
    _ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    switch (object) {
      case "customer":
        return [...CHARGEBEE_CUSTOMER_FIELDS];
      case "contact":
        return [...CHARGEBEE_CONTACT_FIELDS];
      case "product":
        return [...CHARGEBEE_PRODUCT_FIELDS];
      case "offering":
        return [...CHARGEBEE_OFFERING_FIELDS];
      case "price":
        return [...CHARGEBEE_PRICE_FIELDS];
      case "feature":
        return [...CHARGEBEE_FEATURE_FIELDS];
      case "entitlement":
        return [...CHARGEBEE_ENTITLEMENT_FIELDS];
      case "agreement":
        return [...CHARGEBEE_AGREEMENT_FIELDS];
      case "subscription":
        return [...CHARGEBEE_SUBSCRIPTION_FIELDS];
      case "agreementItem":
        return [...CHARGEBEE_AGREEMENT_ITEM_FIELDS];
      case "agreementEntitlement":
        return [...CHARGEBEE_AGREEMENT_ENTITLEMENT_FIELDS];
      case "agreementDiscount":
        return [...CHARGEBEE_AGREEMENT_DISCOUNT_FIELDS];
    }
  },
};
