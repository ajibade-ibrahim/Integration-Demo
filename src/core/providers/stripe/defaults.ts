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
  // Synthesized by `flattenPrice` from three nested fields no rule can combine.
  { sourceFieldPath: "billing_model", targetObject: "price", targetFieldPath: "billingModel", transform: "none" },

  // --- feature ---
  // The definition. `feature_name` and `lookup_key` are synthesized by
  // `flattenFeatureDefinition`, which lifts them out of the nested
  // `entitlement_feature`; the provider's own `feat_…` id becomes the row's
  // `externalSourceId`, so there is no separate feature-id rule.
  { sourceFieldPath: "feature_name", targetObject: "feature", targetFieldPath: "name", transform: "trim" },
  { sourceFieldPath: "lookup_key", targetObject: "feature", targetFieldPath: "lookupKey", transform: "trim" },

  // --- entitlement ---
  // Deliberately empty. Stripe's attachment carries nothing mappable of its own
  // — no value, no limit — and every useful column on the row (both
  // associations, both provider ids) is derived by the engine from the record's
  // refs. A rule here could only name a field the payload does not carry.
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
  // Stripe's flat `metadata`, serialized to JSON by `flattenSubscription`.
  { sourceFieldPath: "provider_metadata", targetObject: "agreement", targetFieldPath: "providerMetadata", transform: "none" },

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
  { sourceFieldPath: "trial_starts_at", targetObject: "subscription", targetFieldPath: "trialStartsAt", transform: "none" },
  { sourceFieldPath: "trial_ends_at", targetObject: "subscription", targetFieldPath: "trialEndsAt", transform: "none" },
  { sourceFieldPath: "canceled_at", targetObject: "subscription", targetFieldPath: "canceledAt", transform: "none" },
  { sourceFieldPath: "cancel_at", targetObject: "subscription", targetFieldPath: "cancelAt", transform: "none" },
  { sourceFieldPath: "cancel_at_period_end", targetObject: "subscription", targetFieldPath: "cancelAtPeriodEnd", transform: "none" },
  // `collection_method` is synthesized from Stripe's `charge_automatically` /
  // `send_invoice` into our `automatic` / `manual`; the raw field would store a
  // word the writer rejects into a null.
  { sourceFieldPath: "collection_method", targetObject: "subscription", targetFieldPath: "collectionMethod", transform: "none" },
  // The primary line's cadence. Both synthesize from `items.0.price.recurring`,
  // which no single mapping path reaches; absent for a subscription whose
  // primary line does not recur.
  { sourceFieldPath: "billing_period", targetObject: "subscription", targetFieldPath: "billingPeriod", transform: "none" },
  { sourceFieldPath: "billing_period_count", targetObject: "subscription", targetFieldPath: "billingPeriodCount", transform: "none" },
  { sourceFieldPath: "quantity", targetObject: "subscription", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "item_count", targetObject: "subscription", targetFieldPath: "itemCount", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "subscription", targetFieldPath: "providerMetadata", transform: "none" },

  // --- agreementItem ---
  // `quantity` is the item's own field, read raw: a subscription item really
  // does carry one, unlike the subscription above whose `quantity` is
  // synthesized from its first item. The rest are synthesized, each for a
  // reason the raw payload cannot supply — `position` is the caller's index
  // across the completed item list, `item_type` is a reading of
  // `price.recurring.usage_type`, `billing_model` combines `price.type`,
  // `recurring.usage_type` and `billing_scheme`, and `provider_metadata` is the
  // item's own flat `metadata` serialized.
  //
  // No defaults for `associatedAgreementId` or `associatedOfferingId`: both
  // are `readOnly` and derived by the engine from the refs. The agreement one
  // matters most — the item's own `subscription` field is right there and
  // mapping it would look correct while bypassing the injection that keeps a
  // line from reassigning itself to another agreement.
  { sourceFieldPath: "quantity", targetObject: "agreementItem", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "position", targetObject: "agreementItem", targetFieldPath: "position", transform: "none" },
  { sourceFieldPath: "item_type", targetObject: "agreementItem", targetFieldPath: "itemType", transform: "none" },
  { sourceFieldPath: "billing_model", targetObject: "agreementItem", targetFieldPath: "billingModel", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "agreementItem", targetFieldPath: "providerMetadata", transform: "none" },
];

/**
 * Billing defaults for Stripe.
 *
 * Covers all three objects, and `payment.kind` is the load-bearing entry: it
 * is the only required field in the whole billing function, and both a charge
 * and a refund come off the same object, so without the rule every payment
 * record is rejected on every sync. `provider-defaults.test.ts` checks required
 * fields from the schema, which is what keeps it here.
 *
 * Most source paths are synthesized by the flatteners: the invoice and payment
 * dates are epoch seconds, the statuses are Stripe's vocabulary, the ids are
 * nested, and `unit_amount_minor` carries a decimal string. Two absences are
 * deliberate. `taxMinor` and `discountMinor` have no rule because Stripe states
 * them as arrays of per-source amounts, and summing them is the arithmetic this
 * function refuses; `Invoice.totalMinor` and `amountPaidMinor` are mapped from
 * Stripe's own stated figures instead.
 */
export const stripeBillingDefaults: FieldMappingRule[] = [
  // --- invoice ---
  { sourceFieldPath: "number", targetObject: "invoice", targetFieldPath: "number", transform: "trim" },
  { sourceFieldPath: "status", targetObject: "invoice", targetFieldPath: "status", transform: "none" },
  { sourceFieldPath: "currency", targetObject: "invoice", targetFieldPath: "currency", transform: "lowercase" },
  { sourceFieldPath: "subtotal", targetObject: "invoice", targetFieldPath: "subtotalMinor", transform: "none" },
  { sourceFieldPath: "total", targetObject: "invoice", targetFieldPath: "totalMinor", transform: "none" },
  { sourceFieldPath: "amount_due", targetObject: "invoice", targetFieldPath: "amountDueMinor", transform: "none" },
  { sourceFieldPath: "amount_paid", targetObject: "invoice", targetFieldPath: "amountPaidMinor", transform: "none" },
  { sourceFieldPath: "issued_at", targetObject: "invoice", targetFieldPath: "issuedAt", transform: "none" },
  { sourceFieldPath: "due_at", targetObject: "invoice", targetFieldPath: "dueAt", transform: "none" },
  { sourceFieldPath: "period_start", targetObject: "invoice", targetFieldPath: "periodStart", transform: "none" },
  { sourceFieldPath: "period_end", targetObject: "invoice", targetFieldPath: "periodEnd", transform: "none" },
  { sourceFieldPath: "paid_at", targetObject: "invoice", targetFieldPath: "paidAt", transform: "none" },
  { sourceFieldPath: "hosted_invoice_url", targetObject: "invoice", targetFieldPath: "hostedUrl", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "invoice", targetFieldPath: "providerMetadata", transform: "none" },

  // --- invoiceLine ---
  { sourceFieldPath: "description", targetObject: "invoiceLine", targetFieldPath: "description", transform: "trim" },
  { sourceFieldPath: "quantity", targetObject: "invoiceLine", targetFieldPath: "quantity", transform: "none" },
  { sourceFieldPath: "unit_amount_minor", targetObject: "invoiceLine", targetFieldPath: "unitAmountMinor", transform: "none" },
  { sourceFieldPath: "amount", targetObject: "invoiceLine", targetFieldPath: "amountMinor", transform: "none" },
  { sourceFieldPath: "period_start", targetObject: "invoiceLine", targetFieldPath: "periodStart", transform: "none" },
  { sourceFieldPath: "period_end", targetObject: "invoiceLine", targetFieldPath: "periodEnd", transform: "none" },
  { sourceFieldPath: "is_proration", targetObject: "invoiceLine", targetFieldPath: "isProration", transform: "none" },
  { sourceFieldPath: "item_type", targetObject: "invoiceLine", targetFieldPath: "itemType", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "invoiceLine", targetFieldPath: "providerMetadata", transform: "none" },

  // --- payment ---
  { sourceFieldPath: "kind", targetObject: "payment", targetFieldPath: "kind", transform: "none" },
  { sourceFieldPath: "status", targetObject: "payment", targetFieldPath: "status", transform: "none" },
  { sourceFieldPath: "amount", targetObject: "payment", targetFieldPath: "amountMinor", transform: "none" },
  { sourceFieldPath: "currency", targetObject: "payment", targetFieldPath: "currency", transform: "lowercase" },
  { sourceFieldPath: "processed_at", targetObject: "payment", targetFieldPath: "processedAt", transform: "none" },
  { sourceFieldPath: "method", targetObject: "payment", targetFieldPath: "method", transform: "none" },
  { sourceFieldPath: "failure_reason", targetObject: "payment", targetFieldPath: "failureReason", transform: "none" },
  { sourceFieldPath: "is_disputed", targetObject: "payment", targetFieldPath: "isDisputed", transform: "none" },
  { sourceFieldPath: "provider_reference", targetObject: "payment", targetFieldPath: "providerReference", transform: "none" },
  { sourceFieldPath: "provider_metadata", targetObject: "payment", targetFieldPath: "providerMetadata", transform: "none" },
];
