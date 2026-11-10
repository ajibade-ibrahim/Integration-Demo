/**
 * Suggested starting mappings for Metrifox.
 *
 * Two absences are deliberate, for the same reason the HubSpot defaults omit
 * `type`: a default that fails validation on every record of every sync is
 * worse than no default at all.
 *
 *   `customer.industry` — Metrifox has no industry field. Nothing to map.
 *   `customer.type`     — `customer_type` is BUSINESS/INDIVIDUAL, a legal-entity
 *                         classification. Our `type` is a relationship stage
 *                         (prospect/customer/partner/vendor). Mapping one onto
 *                         the other yields "business", which the record writer
 *                         warns about and drops on every record forever, so it
 *                         goes to a custom field instead.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const metrifoxIdentityDefaults: FieldMappingRule[] = [
  // --- customer ---
  { sourceFieldPath: "display_name", targetObject: "customer", targetFieldPath: "name", transform: "trim" },
  // `domain` wants a bare host, and Metrifox gives a full URL with a path.
  { sourceFieldPath: "website_url", targetObject: "customer", targetFieldPath: "domain", transform: "domainFromUrl" },
  { sourceFieldPath: "created_at", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  { sourceFieldPath: "customer_key", targetObject: "customer", targetFieldPath: "customFields.customer_key", transform: "none" },
  { sourceFieldPath: "legal_name", targetObject: "customer", targetFieldPath: "customFields.legal_name", transform: "trim" },
  { sourceFieldPath: "customer_type", targetObject: "customer", targetFieldPath: "customFields.customer_type", transform: "none" },
  // Targets the first-class `email` field, not a custom one: identity
  // resolution matches on it, and Metrifox is one of only two providers that
  // supplies an account-level address at all. Often a role address
  // (`billing@`, `accounts@`), which is exactly what the spec says to seed the
  // identity table from.
  { sourceFieldPath: "primary_email", targetObject: "customer", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "currency", targetObject: "customer", targetFieldPath: "customFields.currency", transform: "none" },
  { sourceFieldPath: "country", targetObject: "customer", targetFieldPath: "customFields.country", transform: "trim" },
  // The `payments_stripe_customers` join, on by default rather than left as a
  // manual step. It is the strongest match kind there is — it groups a Metrifox
  // customer with its Stripe counterpart even when they share no email and no
  // domain — and a deterministic join nobody switches on is a join that does
  // not happen.
  //
  // Costs nothing where the field is absent: `applyMappings` emits no
  // cross-reference for a source field that is not there, which is every
  // Metrifox tenant whose API does not serve one.
  { sourceFieldPath: "stripe_customer_id", targetObject: "customer", targetFieldPath: "crossRef.stripe", transform: "trim" },

  // --- contact ---
  // `full_name` is synthesized by the handler from first + last, which is why
  // Metrifox has none of HubSpot's "surnames vanish" problem.
  { sourceFieldPath: "full_name", targetObject: "contact", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "email_address", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "designation", targetObject: "contact", targetFieldPath: "jobTitle", transform: "trim" },
  { sourceFieldPath: "phone_number", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
  { sourceFieldPath: "department", targetObject: "contact", targetFieldPath: "customFields.department", transform: "trim" },
  { sourceFieldPath: "is_primary", targetObject: "contact", targetFieldPath: "customFields.is_primary", transform: "none" },
];

/**
 * Suggested starting mappings for the Metrifox agreement.
 *
 * Covers the four objects the handler writes. Almost every source path is
 * synthesized by `flattenMetrifoxSubscription`, `flattenMetrifoxSubscriptionItem`
 * and `flattenMetrifoxAgreementEntitlement`: the payload names dates and status
 * in Metrifox's vocabulary, and the line and entitlement ids do not exist at
 * all. The raw inputs are still on the record, so a user can override any
 * synthesis.
 *
 * Deliberate absences, each a fact the API does not state:
 *
 *   `agreement.cancelAt`/`cancelAtPeriodEnd`/`subscription.trialStartsAt` —
 *       `SubscriptionView` states no cancellation intent and no trial start.
 *   `subscription.billingPeriod`/`billingPeriodCount`/`collectionMethod`/
 *       `quantity` — none is on the subscription view.
 *   `agreementItem.unitPriceMinor` — Metrifox states `unit_price` in standard
 *       units and gives no per-line currency exponent, so converting would be
 *       a guess. The number stays in `provider_metadata`.
 *   `agreementEntitlement.isOverride`/`valueName` — not stated;
 *       `feature_name` names the feature, not an entitlement level.
 *   `agreementDiscount` — no documented per-subscription discount source.
 *   `metadata.*` — per-tenant keys, the reason every provider here gives.
 *
 * `limit_value` is the load-bearing entitlement rule. It reads the synthesized
 * sentinel (`usage_limit`, or `unlimited` when null) rather than
 * `purchased_qty`, because the writer falls back to `value` when no limit is
 * mapped. `value` is the purchased quantity, as `/agreements` renders it.
 */
export const metrifoxAgreementDefaults: readonly FieldMappingRule[] = [
  // --- agreement ---
  {
    sourceFieldPath: "agreement_name",
    targetObject: "agreement",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "agreement_type",
    targetObject: "agreement",
    targetFieldPath: "agreementType",
    transform: "none",
  },
  {
    sourceFieldPath: "status",
    targetObject: "agreement",
    targetFieldPath: "status",
    transform: "none",
  },
  {
    sourceFieldPath: "raw_status",
    targetObject: "agreement",
    targetFieldPath: "customFields.metrifox_status",
    transform: "none",
  },
  {
    sourceFieldPath: "effective_date",
    targetObject: "agreement",
    targetFieldPath: "effectiveDate",
    transform: "none",
  },
  {
    sourceFieldPath: "end_date",
    targetObject: "agreement",
    targetFieldPath: "endDate",
    transform: "none",
  },
  // Raw `currency_code`, lowercased for the canonical column.
  {
    sourceFieldPath: "currency_code",
    targetObject: "agreement",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "agreement",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },

  // --- subscription ---
  {
    sourceFieldPath: "current_period_start",
    targetObject: "subscription",
    targetFieldPath: "currentPeriodStart",
    transform: "none",
  },
  {
    sourceFieldPath: "current_period_end",
    targetObject: "subscription",
    targetFieldPath: "currentPeriodEnd",
    transform: "none",
  },
  {
    sourceFieldPath: "next_billing_at",
    targetObject: "subscription",
    targetFieldPath: "nextBillingAt",
    transform: "none",
  },
  {
    sourceFieldPath: "trial_ends_at",
    targetObject: "subscription",
    targetFieldPath: "trialEndsAt",
    transform: "none",
  },
  {
    sourceFieldPath: "canceled_at",
    targetObject: "subscription",
    targetFieldPath: "canceledAt",
    transform: "none",
  },
  {
    sourceFieldPath: "item_count",
    targetObject: "subscription",
    targetFieldPath: "itemCount",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "subscription",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },

  // --- agreementItem ---
  // `price_id`, `offering_id` and `agreement_id` are associations the engine
  // resolves from the record's refs, so none has a rule.
  {
    sourceFieldPath: "quantity",
    targetObject: "agreementItem",
    targetFieldPath: "quantity",
    transform: "none",
  },
  {
    sourceFieldPath: "position",
    targetObject: "agreementItem",
    targetFieldPath: "position",
    transform: "none",
  },
  {
    sourceFieldPath: "item_type",
    targetObject: "agreementItem",
    targetFieldPath: "itemType",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "agreementItem",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },

  // --- agreementEntitlement ---
  {
    sourceFieldPath: "value",
    targetObject: "agreementEntitlement",
    targetFieldPath: "value",
    transform: "none",
  },
  // The synthesized sentinel, never `usage_limit` directly: a null usage limit
  // would then leave `limitValue` unmapped and the writer would fall back to
  // `value` (the purchased quantity) as a hard limit.
  {
    sourceFieldPath: "limit_value",
    targetObject: "agreementEntitlement",
    targetFieldPath: "limitValue",
    transform: "none",
  },
  {
    sourceFieldPath: "is_enabled",
    targetObject: "agreementEntitlement",
    targetFieldPath: "isEnabled",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "agreementEntitlement",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },
];

/**
 * Suggested starting mappings for the Metrifox billing function.
 *
 * Invoice summaries only: the public API exposes no invoice lines and no
 * payment list, so there is no default for either and the mapping editor does
 * not offer their sections for this provider.
 *
 * The amounts are the load-bearing part. Metrifox states them in standard
 * units, and the handler synthesizes `*_minor` by multiplying by the currency
 * exponent (`USD` 2, `JPY` 0, `KWD` 3). The defaults map the synthesized keys,
 * never the raw figures, because our columns are integer minor units — mapping
 * `total_amount` directly would make the writer reject a decimal or store 21
 * cents for a $21 invoice. The raw figures remain in `provider_metadata`.
 *
 * `issuedAt` reads the synthesized `issued_at`, not raw `issued_date`: the
 * handler ignores draft invoices entirely, and the synthesized key is also
 * absent if a draft is ever flattened directly, so a future issue date cannot
 * claim the invoice was issued. `due_date` is stated and maps directly.
 *
 * Deliberate absences, each a fact the API does not state:
 *
 *   `subtotalMinor`, `discountMinor`, `taxMinor` — no breakdown is returned.
 *   `paidAt`, `periodStart`, `periodEnd`, `hostedUrl` — none is on the
 *       billing-history summary.
 *
 * `number`, `status`, `currency`, `providerMetadata` and the `customFields`
 * status are the direct mappings; the status word is translated by the
 * handler, and Metrifox's own word is kept in `customFields.metrifox_status`.
 */
export const metrifoxBillingDefaults: readonly FieldMappingRule[] = [
  // --- invoice ---
  {
    sourceFieldPath: "invoice_number",
    targetObject: "invoice",
    targetFieldPath: "number",
    transform: "none",
  },
  {
    sourceFieldPath: "status",
    targetObject: "invoice",
    targetFieldPath: "status",
    transform: "none",
  },
  {
    sourceFieldPath: "raw_status",
    targetObject: "invoice",
    targetFieldPath: "customFields.metrifox_status",
    transform: "none",
  },
  {
    sourceFieldPath: "currency",
    targetObject: "invoice",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "total_amount_minor",
    targetObject: "invoice",
    targetFieldPath: "totalMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "amount_paid_minor",
    targetObject: "invoice",
    targetFieldPath: "amountPaidMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "balance_due_minor",
    targetObject: "invoice",
    targetFieldPath: "amountDueMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "issued_at",
    targetObject: "invoice",
    targetFieldPath: "issuedAt",
    transform: "none",
  },
  {
    sourceFieldPath: "due_date",
    targetObject: "invoice",
    targetFieldPath: "dueAt",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "invoice",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },
];
