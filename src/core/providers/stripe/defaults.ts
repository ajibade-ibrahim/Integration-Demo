/**
 * Suggested starting mappings for Stripe.
 *
 * These are not merely a convenience: an invalid rule here is a connect-time
 * hard failure, because seeding runs through the same `validateMappings` the
 * editor does and the draft path rolls the new integration back when it throws.
 *
 * Three absences are deliberate.
 *
 *   `customer.domain`   — Stripe has no website field. Mapping `email` with
 *                         `domainFromUrl` does in fact yield the host (the
 *                         transform prefixes a scheme, and URL parses the local
 *                         part as userinfo), so a user who wants it can have it
 *                         in one click. It is not a default because it turns
 *                         every consumer address into "gmail.com" as a company
 *                         domain, which is worse than an empty column.
 *   `customer.industry` — Stripe has no industry field. Nothing to map.
 *   `customer.type`     — our `type` is a relationship stage
 *                         (prospect/customer/partner/vendor). Stripe has no
 *                         equivalent, and `delinquent` is a payment state, not
 *                         a relationship; it goes to a custom field instead.
 *
 * No `metadata.*` rules either, for the same reason Metrifox has none despite
 * discovery surfacing them: the keys are per-account, so any default naming one
 * would be blank for everybody else. `customFields.<key>` takes a single
 * segment anyway, so `customFields.metadata.tier` would not even validate.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const stripeIdentityDefaults: FieldMappingRule[] = [
  // --- customer ---
  { sourceFieldPath: "name", targetObject: "customer", targetFieldPath: "name", transform: "trim" },
  // `created_at` is synthesized by the handler from `created`. Mapping `created`
  // directly stores nothing: epoch seconds do not survive the date parse.
  { sourceFieldPath: "created_at", targetObject: "customer", targetFieldPath: "createDate", transform: "none" },
  { sourceFieldPath: "email", targetObject: "customer", targetFieldPath: "customFields.email", transform: "lowercase" },
  { sourceFieldPath: "description", targetObject: "customer", targetFieldPath: "customFields.description", transform: "trim" },
  { sourceFieldPath: "currency", targetObject: "customer", targetFieldPath: "customFields.currency", transform: "none" },
  // `0` and `false` survive: the mapper drops empty strings and nulls from
  // custom fields, not falsy stringifications.
  { sourceFieldPath: "balance", targetObject: "customer", targetFieldPath: "customFields.balance", transform: "none" },
  { sourceFieldPath: "delinquent", targetObject: "customer", targetFieldPath: "customFields.delinquent", transform: "none" },
  { sourceFieldPath: "address.country", targetObject: "customer", targetFieldPath: "customFields.country", transform: "trim" },

  // --- contact ---
  // Every path here is synthesized by the handler — Stripe has no contact
  // resource — which is why none of them look like Stripe field names.
  { sourceFieldPath: "contact_name", targetObject: "contact", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "email", targetObject: "contact", targetFieldPath: "email", transform: "lowercase" },
  { sourceFieldPath: "phone", targetObject: "contact", targetFieldPath: "phone", transform: "trim" },
  { sourceFieldPath: "customer_name", targetObject: "contact", targetFieldPath: "customFields.customer_name", transform: "trim" },
];
