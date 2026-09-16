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
  // Targets the first-class `email` field, not a custom one: identity
  // resolution matches on it, and Stripe is one of only two providers that
  // supplies an account-level address at all.
  { sourceFieldPath: "email", targetObject: "customer", targetFieldPath: "email", transform: "lowercase" },
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

/**
 * Suggested starting mappings for the Stripe catalog.
 *
 * Four of the offering rules name fields that do not exist in Stripe's
 * response — `offering_name`, `interval`, `interval_count`, `product_id` are
 * synthesized by `flattenPrice`. That is the same arrangement `created_at` has
 * on the identity side, and for the same reason: the raw shape does not survive
 * the trip through the mapper, so the handler fixes it while it still can.
 *
 * Two absences are deliberate.
 *
 *   `offering.active`  — mapped, unlike on product. Stripe deactivates a price
 *                        far more often than a product (a price change is a new
 *                        price plus a deactivation), so this is the column that
 *                        tells a live catalog from an archived one.
 *   `product.url` and  — real fields, deliberately unmapped. Neither is part of
 *   `unit_label`         our schema, and putting them in `customFields` by
 *                        default would spend two of a user's fifty custom keys
 *                        on values most catalogs leave blank.
 *
 * No `metadata.*` rules, for the reason the identity defaults give: the keys
 * are per-account, so any default naming one is blank for everybody else.
 */
export const stripeCatalogDefaults: FieldMappingRule[] = [
  // --- product ---
  { sourceFieldPath: "name", targetObject: "product", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "description", targetObject: "product", targetFieldPath: "description", transform: "trim" },
  { sourceFieldPath: "active", targetObject: "product", targetFieldPath: "active", transform: "none" },
  // `created_at` is synthesized from `created`; mapping `created` stores
  // nothing, because epoch seconds do not survive the date parse.
  { sourceFieldPath: "created_at", targetObject: "product", targetFieldPath: "customFields.created_at", transform: "none" },

  // --- offering ---
  { sourceFieldPath: "offering_name", targetObject: "offering", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "unit_amount", targetObject: "offering", targetFieldPath: "amountMinor", transform: "none" },
  // Lowercased to match the ISO 4217 form the rest of the app compares against;
  // Stripe returns it lowercase already, so this is belt and braces.
  { sourceFieldPath: "currency", targetObject: "offering", targetFieldPath: "currency", transform: "lowercase" },
  { sourceFieldPath: "interval", targetObject: "offering", targetFieldPath: "interval", transform: "none" },
  { sourceFieldPath: "interval_count", targetObject: "offering", targetFieldPath: "intervalCount", transform: "none" },
  { sourceFieldPath: "active", targetObject: "offering", targetFieldPath: "active", transform: "none" },
  { sourceFieldPath: "billing_scheme", targetObject: "offering", targetFieldPath: "customFields.billing_scheme", transform: "none" },
  { sourceFieldPath: "recurring.usage_type", targetObject: "offering", targetFieldPath: "customFields.usage_type", transform: "none" },
];
