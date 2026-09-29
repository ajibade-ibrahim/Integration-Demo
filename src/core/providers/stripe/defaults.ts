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
 * Three of the price rules name fields that do not exist in Stripe's response —
 * `offering_name`, `interval` and `interval_count` are synthesized by
 * `flattenPrice`. That is the same arrangement `created_at` has on the identity
 * side, and for the same reason: the raw shape does not survive the trip through
 * the mapper, so the handler fixes it while it still can.
 *
 * The product and offering rules read the *same* three fields, and that is not a
 * copy-paste: in Stripe a product has one offering under the same id, so the two
 * targets are two views of one row and there is nothing else for the offering to
 * carry. `price.active` is mapped where `product.active` is not needed on the
 * offering for a reason of its own — Stripe deactivates a price far more often
 * than a product (a price change is a new price plus a deactivation), so on the
 * price it is the column that tells a live catalog from an archived one.
 *
 * Two absences are deliberate.
 *
 *   `price.product_id` — the offering link, and it needs no rule: the engine
 *                        derives every association from the record's refs, and
 *                        this one lands in `associatedOfferingId`.
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

  // --- offering ---
  { sourceFieldPath: "name", targetObject: "offering", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "description", targetObject: "offering", targetFieldPath: "description", transform: "trim" },
  { sourceFieldPath: "active", targetObject: "offering", targetFieldPath: "active", transform: "none" },

  // --- price ---
  { sourceFieldPath: "offering_name", targetObject: "price", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "unit_amount", targetObject: "price", targetFieldPath: "amountMinor", transform: "none" },
  { sourceFieldPath: "currency", targetObject: "price", targetFieldPath: "currency", transform: "lowercase" },
  { sourceFieldPath: "interval", targetObject: "price", targetFieldPath: "interval", transform: "none" },
  { sourceFieldPath: "interval_count", targetObject: "price", targetFieldPath: "intervalCount", transform: "none" },
  { sourceFieldPath: "active", targetObject: "price", targetFieldPath: "active", transform: "none" },

  // --- feature ---
  { sourceFieldPath: "feature_name", targetObject: "feature", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "lookup_key", targetObject: "feature", targetFieldPath: "lookupKey", transform: "trim" },
  { sourceFieldPath: "feature_id", targetObject: "feature", targetFieldPath: "externalFeatureId", transform: "none" },
];

/**
 * Agreement defaults for Stripe.
 *
 * Covers both objects the function writes, because a rule set that mapped only
 * the agreement half would sync subscriptions with no period dates — the one
 * thing the detail table exists to hold.
 *
 * `agreement_name` is the load-bearing entry. `Agreement.name` is required and
 * Stripe's subscriptions have no name, so without this rule every record is
 * rejected on every sync. `provider-defaults.test.ts` asserts exactly that for
 * each object's required fields, which is what keeps it here.
 *
 * Note the source paths are almost all synthesized by `flattenSubscription`
 * rather than read from the response: the dates are epoch seconds in Stripe's
 * payload, the status is Stripe's vocabulary, and the two ids are nested inside
 * `items`. Mapping the raw paths instead would store numbers in date columns
 * and Stripe's words in our enum.
 */
export const stripeAgreementDefaults: FieldMappingRule[] = [
  // --- agreement ---
  { sourceFieldPath: "agreement_name", targetObject: "agreement", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "agreement_type", targetObject: "agreement", targetFieldPath: "agreementType", transform: "none" },
  { sourceFieldPath: "status", targetObject: "agreement", targetFieldPath: "status", transform: "none" },
  { sourceFieldPath: "effective_date", targetObject: "agreement", targetFieldPath: "effectiveDate", transform: "none" },
  { sourceFieldPath: "ended_at", targetObject: "agreement", targetFieldPath: "endDate", transform: "none" },
  // Lowercased to match the ISO 4217 form the rest of the app compares against.
  { sourceFieldPath: "currency", targetObject: "agreement", targetFieldPath: "currency", transform: "lowercase" },
  { sourceFieldPath: "raw_status", targetObject: "agreement", targetFieldPath: "customFields.stripe_status", transform: "none" },
  { sourceFieldPath: "created_at", targetObject: "agreement", targetFieldPath: "customFields.created_at", transform: "none" },

  // --- subscription ---
  { sourceFieldPath: "current_period_start", targetObject: "subscription", targetFieldPath: "currentPeriodStart", transform: "none" },
  { sourceFieldPath: "current_period_end", targetObject: "subscription", targetFieldPath: "currentPeriodEnd", transform: "none" },
  { sourceFieldPath: "trial_ends_at", targetObject: "subscription", targetFieldPath: "trialEndsAt", transform: "none" },
  { sourceFieldPath: "canceled_at", targetObject: "subscription", targetFieldPath: "canceledAt", transform: "none" },
  { sourceFieldPath: "cancel_at_period_end", targetObject: "subscription", targetFieldPath: "cancelAtPeriodEnd", transform: "none" },
  { sourceFieldPath: "collection_method", targetObject: "subscription", targetFieldPath: "collectionMethod", transform: "none" },
  { sourceFieldPath: "quantity", targetObject: "subscription", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "item_count", targetObject: "subscription", targetFieldPath: "itemCount", transform: "none" },

  // --- agreementItem ---
  // `quantity` is the item's own field, read raw: a subscription item really
  // does carry one, unlike the subscription above whose `quantity` is
  // synthesized from its first item. The other two are synthesized, and both
  // for reasons the raw payload cannot supply — `position` is the caller's
  // index across the completed item list, and `item_type` is a reading of
  // `price.recurring.usage_type` that resolves to nothing at all unless the
  // line is metered.
  //
  // No defaults for `associatedAgreementId` or `associatedOfferingId`: both
  // are `readOnly` and derived by the engine from the refs. The agreement one
  // matters most — the item's own `subscription` field is right there and
  // mapping it would look correct while bypassing the injection that keeps a
  // line from reassigning itself to another agreement.
  { sourceFieldPath: "quantity", targetObject: "agreementItem", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "position", targetObject: "agreementItem", targetFieldPath: "position", transform: "none" },
  { sourceFieldPath: "item_type", targetObject: "agreementItem", targetFieldPath: "itemType", transform: "none" },
];
