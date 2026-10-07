/**
 * Suggested starting mappings for Stigg.
 *
 * These are seeded when an integration is first authorized, so they run through
 * the same `validateMappings` the editor does — an invalid rule here is a
 * connect-time hard failure, not a cosmetic default. See
 * `provider-defaults.test.ts`.
 *
 * Three absences are deliberate, and they are the Metrifox/Stripe ones:
 *
 *   `customer.domain`   — Stigg has no website field. Nothing to map.
 *   `customer.industry` — Stigg has no industry field. Nothing to map.
 *   `customer.type`     — our `type` is a relationship stage
 *                         (prospect/customer/partner/vendor). Stigg states no
 *                         equivalent, so there is nothing to translate; a guess
 *                         would be warned about and dropped on every record.
 *
 * No `metadata.*` rules, for the reason every provider here gives: the keys are
 * per-environment, so any default naming one would be blank for everybody else.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const stiggIdentityDefaults: FieldMappingRule[] = [
  // --- customer ---
  { sourceFieldPath: "name", targetObject: "customer", targetFieldPath: "name", transform: "trim" },
  // Targets the first-class `email` field, not a custom one: identity
  // resolution matches on it, and Stigg supplies an account-level address.
  { sourceFieldPath: "email", targetObject: "customer", targetFieldPath: "email", transform: "lowercase" },
  // `createdAt` is already an ISO string in Stigg's payload, unlike Stripe's
  // epoch seconds, so it needs no synthesized date.
  { sourceFieldPath: "createdAt", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  // Synthesized by the handler from `integrations[]`. Costs nothing where the
  // field is absent: `applyMappings` emits no cross-reference for a source
  // field that is not there, which is every customer with no Stripe link.
  //
  // `billingId` deliberately does **not** feed this rule — it names the billing
  // provider's entity, which may be Zuora, so asserting it is a Stripe id would
  // be wrong. It goes to a custom field below.
  { sourceFieldPath: "stripe_customer_id", targetObject: "customer", targetFieldPath: "crossRef.stripe", transform: "trim" },
  { sourceFieldPath: "billingId", targetObject: "customer", targetFieldPath: "customFields.billing_id", transform: "trim" },
  { sourceFieldPath: "billingCurrency", targetObject: "customer", targetFieldPath: "customFields.billing_currency", transform: "none" },
  { sourceFieldPath: "timezone", targetObject: "customer", targetFieldPath: "customFields.timezone", transform: "trim" },
  { sourceFieldPath: "language", targetObject: "customer", targetFieldPath: "customFields.language", transform: "trim" },
  // Archived customers still sync — Stigg archives rather than deletes and keeps
  // returning them from the list endpoint — so the moment is kept as a custom
  // field rather than used as a filter.
  { sourceFieldPath: "archivedAt", targetObject: "customer", targetFieldPath: "customFields.archived_at", transform: "none" },

  // --- contact ---
  // Every path here is synthesized by the handler — Stigg has no contact
  // resource — which is why none of them look like Stigg field names.
  { sourceFieldPath: "contact_name", targetObject: "contact", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "email", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
];

/**
 * Suggested mappings for the Stigg catalog.
 *
 * Covers all five objects. `Offering.name`, `Price.name` and `Feature.name` are
 * required columns, and Stigg's packages do have `displayName`, so the rules
 * are direct; the synthesised paths (`price_name`, `active`, `isMetered`,
 * `value`, `interval`) exist because the payload either nests them, splits them
 * across fields, or names them differently.
 *
 * Deliberate absences:
 *
 *   `entitlement.valueName` — Stigg states no entitlement-level label;
 *       `displayNameOverride` renames the feature, not the level.
 *   `price` tiers           — the canonical `Price` has no tier table, so the
 *       raw `tiers` array stays on the record rather than being flattened.
 *   `metadata.*` rules      — the keys are per-environment, the reason every
 *       provider here gives.
 *   CREDIT entitlements     — dropped by the handler; they describe a
 *       custom-currency pool, not a capability, and have no canonical column.
 */
export const stiggCatalogDefaults: readonly FieldMappingRule[] = [
  // --- product ---
  { sourceFieldPath: "displayName", targetObject: "product", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "description", targetObject: "product", targetFieldPath: "description", transform: "trim" },
  // Synthesized from `status`; absent when Stigg did not state one, so the rule
  // simply does not fire and the column stays null.
  { sourceFieldPath: "active", targetObject: "product", targetFieldPath: "active", transform: "none" },

  // --- offering --- (a plan or addon; same fields on both)
  { sourceFieldPath: "displayName", targetObject: "offering", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "description", targetObject: "offering", targetFieldPath: "description", transform: "trim" },
  { sourceFieldPath: "active", targetObject: "offering", targetFieldPath: "active", transform: "none" },

  // --- price --- (a charge)
  // `price_name` is synthesized because a charge has no name and `Price.name`
  // is required.
  { sourceFieldPath: "price_name", targetObject: "price", targetFieldPath: "name", transform: "trim" },
  // Stigg states `price.amount` in major units; `amount_minor` is the
  // synthesized minor-unit form the canonical column stores (and the one place
  // a units correction would land is `flattenCharge`).
  { sourceFieldPath: "amount_minor", targetObject: "price", targetFieldPath: "amountMinor", transform: "none" },
  { sourceFieldPath: "price.currency", targetObject: "price", targetFieldPath: "currency", transform: "lowercase" },
  // Synthesized from `billingCadence`/`billingPeriod`; omitted for an
  // unrecognised cadence, so the column stays null rather than guessing.
  { sourceFieldPath: "interval", targetObject: "price", targetFieldPath: "interval", transform: "none" },
  { sourceFieldPath: "interval_count", targetObject: "price", targetFieldPath: "intervalCount", transform: "none" },
  { sourceFieldPath: "active", targetObject: "price", targetFieldPath: "active", transform: "none" },
  // Synthesized by `flattenCharge` from Stigg's UPPER_SNAKE `billingModel`.
  { sourceFieldPath: "billing_model", targetObject: "price", targetFieldPath: "billingModel", transform: "none" },
  // Raw: Stigg states the block size directly, and it is absent for a flat price.
  { sourceFieldPath: "blockSize", targetObject: "price", targetFieldPath: "blockSize", transform: "none" },

  // --- feature ---
  { sourceFieldPath: "displayName", targetObject: "feature", targetFieldPath: "name", transform: "trim" },
  // Stigg's feature id is the machine key applications gate on, so it keeps the
  // canonical lookup key meaningful — the Chargebee reasoning.
  { sourceFieldPath: "id", targetObject: "feature", targetFieldPath: "lookupKey", transform: "trim" },
  // Synthesized from `meterType`, which no raw transform can map to a boolean.
  { sourceFieldPath: "isMetered", targetObject: "feature", targetFieldPath: "isMetered", transform: "none" },
  { sourceFieldPath: "featureUnits", targetObject: "feature", targetFieldPath: "unit", transform: "trim" },

  // --- entitlement ---
  // The synthesized answer (limit, "true", "false" or "unlimited") and its
  // numeric form. Two rules write different columns from the same meaning, as
  // Chargebee's do: `value` is what Stigg said, `limitValue` the queryable
  // number.
  { sourceFieldPath: "value", targetObject: "entitlement", targetFieldPath: "value", transform: "none" },
  { sourceFieldPath: "usageLimit", targetObject: "entitlement", targetFieldPath: "limitValue", transform: "none" },
];
