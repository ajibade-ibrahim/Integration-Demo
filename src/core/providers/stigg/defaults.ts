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
