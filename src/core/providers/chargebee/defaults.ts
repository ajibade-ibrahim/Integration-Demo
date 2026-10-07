/**
 * Chargebee default field mappings for identity function.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const chargebeeIdentityDefaults: readonly FieldMappingRule[] = [
  // Customer mapping rules
  {
    sourceFieldPath: "company",
    targetObject: "customer",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "email",
    targetObject: "customer",
    targetFieldPath: "email",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "email",
    targetObject: "customer",
    targetFieldPath: "domain",
    transform: "domainFromUrl",
  },
  {
    sourceFieldPath: "created_at",
    targetObject: "customer",
    targetFieldPath: "createDate",
    transform: "dateOnly",
  },

  // Contact mapping rules
  {
    sourceFieldPath: "contact_name",
    targetObject: "contact",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "email",
    targetObject: "contact",
    targetFieldPath: "email",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "phone",
    targetObject: "contact",
    targetFieldPath: "phone",
    transform: "trim",
  },
];

export const chargebeeCatalogDefaults: readonly FieldMappingRule[] = [
  // Product mapping rules (Item Family)
  {
    sourceFieldPath: "name",
    targetObject: "product",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "description",
    targetObject: "product",
    targetFieldPath: "description",
    transform: "trim",
  },

  // Offering mapping rules (Item)
  {
    sourceFieldPath: "name",
    targetObject: "offering",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "description",
    targetObject: "offering",
    targetFieldPath: "description",
    transform: "trim",
  },

  // Price mapping rules (Item Price)
  {
    sourceFieldPath: "price_name",
    targetObject: "price",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "price",
    targetObject: "price",
    targetFieldPath: "amountMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "currency_code",
    targetObject: "price",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "interval",
    targetObject: "price",
    targetFieldPath: "interval",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "interval_count",
    targetObject: "price",
    targetFieldPath: "intervalCount",
    transform: "none",
  },
  // Synthesized by `flattenItemPrice`: Chargebee's `volume`/`stairstep` collapse
  // to our single `tiered`, which no raw transform can express.
  {
    sourceFieldPath: "billing_model",
    targetObject: "price",
    targetFieldPath: "billingModel",
    transform: "none",
  },

  // Feature definition mapping rules (Chargebee `/features`).
  //
  // `id` feeds the row's `lookupKey`. Chargebee has no separate lookup-key
  // field, but its feature id ("cbdemo_ticketing_module", merchant-set or
  // generated) is the stable, unique string an application gates on — and it
  // is what the features page groups by — so mapping it here is what keeps that
  // column meaningful instead of permanently blank. The same id is also the
  // row's `externalSourceId`, which the writer takes from the record id.
  {
    sourceFieldPath: "id",
    targetObject: "feature",
    targetFieldPath: "lookupKey",
    transform: "trim",
  },
  {
    sourceFieldPath: "name",
    targetObject: "feature",
    targetFieldPath: "name",
    transform: "trim",
  },
  {
    sourceFieldPath: "metered",
    targetObject: "feature",
    targetFieldPath: "isMetered",
    transform: "none",
  },
  {
    sourceFieldPath: "unit",
    targetObject: "feature",
    targetFieldPath: "unit",
    transform: "trim",
  },

  // Entitlement mapping rules (item entitlements).
  //
  // Two rules read `value` and write different columns — the raw provider
  // string kept as `value`, and its numeric form as `limitValue`. That pair is
  // intended: `value` is what Chargebee actually said ("50", "true", or nothing
  // at all), while `limitValue` is the queryable number the page and any future
  // limit logic read.
  {
    sourceFieldPath: "value",
    targetObject: "entitlement",
    targetFieldPath: "value",
    transform: "none",
  },
  {
    sourceFieldPath: "name",
    targetObject: "entitlement",
    targetFieldPath: "valueName",
    transform: "trim",
  },
  {
    sourceFieldPath: "value",
    targetObject: "entitlement",
    targetFieldPath: "limitValue",
    transform: "none",
  },
];

/**
 * Agreement defaults for Chargebee.
 *
 * Covers all five objects the function writes, because Chargebee syncs them all
 * off one list plus one fan-out and a rule set covering only the agreement
 * would leave the rest blank.
 *
 * `agreement_name` is load-bearing for the same reason it is on Stripe:
 * `Agreement.name` is required and Chargebee gives a subscription none, so
 * without this rule every record is rejected every sync. `provider-defaults.test.ts`
 * asserts it.
 *
 * Most source paths are synthesized by `flattenChargebeeSubscription` rather
 * than read from the response: the dates are epoch seconds, the status is
 * Chargebee's vocabulary, and `currency_code` is the raw field mapped with a
 * lowercase transform. The item's `unit_price`, `free_quantity`, `quantity` and
 * `billing_cycles` are read raw — Chargebee inlines them on the subscription
 * item. `billing_model` is deliberately unmapped and stays null: the pricing
 * model lives on the item price this payload does not inline.
 */
export const chargebeeAgreementDefaults: readonly FieldMappingRule[] = [
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
    sourceFieldPath: "effective_date",
    targetObject: "agreement",
    targetFieldPath: "effectiveDate",
    transform: "none",
  },
  {
    sourceFieldPath: "ended_at",
    targetObject: "agreement",
    targetFieldPath: "endDate",
    transform: "none",
  },
  {
    sourceFieldPath: "currency_code",
    targetObject: "agreement",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "chargebee_status",
    targetObject: "agreement",
    targetFieldPath: "customFields.chargebee_status",
    transform: "none",
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
    sourceFieldPath: "trial_starts_at",
    targetObject: "subscription",
    targetFieldPath: "trialStartsAt",
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
    sourceFieldPath: "cancel_at",
    targetObject: "subscription",
    targetFieldPath: "cancelAt",
    transform: "none",
  },
  {
    sourceFieldPath: "cancel_at_period_end",
    targetObject: "subscription",
    targetFieldPath: "cancelAtPeriodEnd",
    transform: "none",
  },
  {
    sourceFieldPath: "collection_method",
    targetObject: "subscription",
    targetFieldPath: "collectionMethod",
    transform: "none",
  },
  {
    sourceFieldPath: "billing_period",
    targetObject: "subscription",
    targetFieldPath: "billingPeriod",
    transform: "none",
  },
  {
    sourceFieldPath: "billing_period_count",
    targetObject: "subscription",
    targetFieldPath: "billingPeriodCount",
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
  // `price_id` is the raw `item_price_id`; `associatedPriceId` and
  // `externalPriceId` are derived by the engine from the ref, so neither has a
  // rule. `offeringId` stays null: the item price's product is not inlined.
  {
    sourceFieldPath: "item_type",
    targetObject: "agreementItem",
    targetFieldPath: "itemType",
    transform: "none",
  },
  {
    sourceFieldPath: "quantity",
    targetObject: "agreementItem",
    targetFieldPath: "quantity",
    transform: "none",
  },
  {
    sourceFieldPath: "unit_price",
    targetObject: "agreementItem",
    targetFieldPath: "unitPriceMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "free_quantity",
    targetObject: "agreementItem",
    targetFieldPath: "freeQuantity",
    transform: "none",
  },
  {
    sourceFieldPath: "billing_cycles",
    targetObject: "agreementItem",
    targetFieldPath: "billingCycles",
    transform: "none",
  },
  {
    sourceFieldPath: "position",
    targetObject: "agreementItem",
    targetFieldPath: "position",
    transform: "none",
  },

  // --- agreementEntitlement ---
  // The catalog entitlement rules' shape, one level over: `value` is the raw
  // provider string and `limitValue` its numeric form, and `name` is the
  // entitlement *level* label rather than the feature name.
  {
    sourceFieldPath: "value",
    targetObject: "agreementEntitlement",
    targetFieldPath: "value",
    transform: "none",
  },
  {
    sourceFieldPath: "name",
    targetObject: "agreementEntitlement",
    targetFieldPath: "valueName",
    transform: "trim",
  },
  {
    sourceFieldPath: "value",
    targetObject: "agreementEntitlement",
    targetFieldPath: "limitValue",
    transform: "none",
  },
  {
    sourceFieldPath: "is_overridden",
    targetObject: "agreementEntitlement",
    targetFieldPath: "isOverride",
    transform: "none",
  },
  {
    sourceFieldPath: "is_enabled",
    targetObject: "agreementEntitlement",
    targetFieldPath: "isEnabled",
    transform: "none",
  },

  // --- agreementDiscount ---
  // Chargebee's discount object is flat, so most paths are its own field names;
  // `discount_kind`, `discount_status`, `starts_at` and `ends_at` are
  // synthesized by `flattenChargebeeDiscount` from `type`, `duration_type`,
  // `created_at` and `apply_till`.
  {
    sourceFieldPath: "coupon_id",
    targetObject: "agreementDiscount",
    targetFieldPath: "externalCouponId",
    transform: "none",
  },
  {
    sourceFieldPath: "invoice_name",
    targetObject: "agreementDiscount",
    targetFieldPath: "label",
    transform: "trim",
  },
  {
    sourceFieldPath: "discount_kind",
    targetObject: "agreementDiscount",
    targetFieldPath: "kind",
    transform: "none",
  },
  {
    sourceFieldPath: "percentage",
    targetObject: "agreementDiscount",
    targetFieldPath: "percentOff",
    transform: "none",
  },
  {
    sourceFieldPath: "amount",
    targetObject: "agreementDiscount",
    targetFieldPath: "amountOffMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "discount_status",
    targetObject: "agreementDiscount",
    targetFieldPath: "status",
    transform: "none",
  },
  {
    sourceFieldPath: "starts_at",
    targetObject: "agreementDiscount",
    targetFieldPath: "startsAt",
    transform: "none",
  },
  {
    sourceFieldPath: "ends_at",
    targetObject: "agreementDiscount",
    targetFieldPath: "endsAt",
    transform: "none",
  },
];

/**
 * Billing defaults for Chargebee.
 *
 * Covers all three objects. Most paths are Chargebee's own field names because
 * the amounts and currency are already top-level and already in cents; the
 * synthesized paths are the status vocabulary, the epoch dates, the association
 * ids and the transaction's derived method, failure reason and dispute flag.
 *
 * `payment.kind` is the load-bearing rule: it is the only required field in the
 * function, and an authorization never yields one, so a transaction without it
 * is dropped by the handler rather than left for the writer to reject.
 *
 * There is no `invoiceLine.itemType` rule, because Chargebee does not state a
 * line type this function's union recognises, and no `discountMinor` rule,
 * because Chargebee states no scalar invoice-level discount.
 */
export const chargebeeBillingDefaults: readonly FieldMappingRule[] = [
  // --- invoice ---
  // Chargebee's invoice id is its invoice number.
  {
    sourceFieldPath: "id",
    targetObject: "invoice",
    targetFieldPath: "number",
    transform: "trim",
  },
  {
    sourceFieldPath: "status",
    targetObject: "invoice",
    targetFieldPath: "status",
    transform: "none",
  },
  {
    sourceFieldPath: "currency_code",
    targetObject: "invoice",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "sub_total",
    targetObject: "invoice",
    targetFieldPath: "subtotalMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "tax",
    targetObject: "invoice",
    targetFieldPath: "taxMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "total",
    targetObject: "invoice",
    targetFieldPath: "totalMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "amount_due",
    targetObject: "invoice",
    targetFieldPath: "amountDueMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "amount_paid",
    targetObject: "invoice",
    targetFieldPath: "amountPaidMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "issued_at",
    targetObject: "invoice",
    targetFieldPath: "issuedAt",
    transform: "none",
  },
  {
    sourceFieldPath: "due_at",
    targetObject: "invoice",
    targetFieldPath: "dueAt",
    transform: "none",
  },
  {
    sourceFieldPath: "paid_at",
    targetObject: "invoice",
    targetFieldPath: "paidAt",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "invoice",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },

  // --- invoiceLine ---
  {
    sourceFieldPath: "description",
    targetObject: "invoiceLine",
    targetFieldPath: "description",
    transform: "trim",
  },
  {
    sourceFieldPath: "quantity",
    targetObject: "invoiceLine",
    targetFieldPath: "quantity",
    transform: "none",
  },
  {
    sourceFieldPath: "unit_amount",
    targetObject: "invoiceLine",
    targetFieldPath: "unitAmountMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "amount",
    targetObject: "invoiceLine",
    targetFieldPath: "amountMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "period_start",
    targetObject: "invoiceLine",
    targetFieldPath: "periodStart",
    transform: "none",
  },
  {
    sourceFieldPath: "period_end",
    targetObject: "invoiceLine",
    targetFieldPath: "periodEnd",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "invoiceLine",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },

  // --- payment ---
  {
    sourceFieldPath: "kind",
    targetObject: "payment",
    targetFieldPath: "kind",
    transform: "none",
  },
  {
    sourceFieldPath: "status",
    targetObject: "payment",
    targetFieldPath: "status",
    transform: "none",
  },
  {
    sourceFieldPath: "amount",
    targetObject: "payment",
    targetFieldPath: "amountMinor",
    transform: "none",
  },
  {
    sourceFieldPath: "currency_code",
    targetObject: "payment",
    targetFieldPath: "currency",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "processed_at",
    targetObject: "payment",
    targetFieldPath: "processedAt",
    transform: "none",
  },
  {
    sourceFieldPath: "method",
    targetObject: "payment",
    targetFieldPath: "method",
    transform: "none",
  },
  {
    sourceFieldPath: "failure_reason",
    targetObject: "payment",
    targetFieldPath: "failureReason",
    transform: "none",
  },
  {
    sourceFieldPath: "is_disputed",
    targetObject: "payment",
    targetFieldPath: "isDisputed",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_reference",
    targetObject: "payment",
    targetFieldPath: "providerReference",
    transform: "none",
  },
  {
    sourceFieldPath: "provider_metadata",
    targetObject: "payment",
    targetFieldPath: "providerMetadata",
    transform: "none",
  },
];
