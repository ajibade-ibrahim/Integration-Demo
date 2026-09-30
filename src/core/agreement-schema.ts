/**
 * The agreement schema: the target fields an `agreement` mapping rule may write.
 *
 * Sibling of `identity-schema.ts` and `catalog-schema.ts`, read through the same
 * consumers via the composed registry in `object-schema.ts`.
 *
 * **Two objects for one source record, and that is the design.** An agreement is
 * the shared commercial node — who agreed, to what, when, and where it stands —
 * and every provider supplies it. The recurring-billing detail beside it is
 * true of subscriptions only: `trialEndsAt` and `currentPeriodEnd` mean nothing
 * on a signed contract, and `poNumber` will mean nothing on a subscription when
 * order forms arrive.
 *
 * Holding both on one object would mean a table that grows a column group per
 * provider and can never mark any of them required, because every column has to
 * tolerate the types that do not have it. Splitting them lets `subscription`
 * require what a subscription always has, and makes the third and fourth types
 * a new table rather than an `ALTER` against rows that already exist.
 *
 * What keeps the split addressable is that the mapping layer resolves one table
 * per target object, so the two tables are two objects. The Stripe handler
 * yields each subscription under both — the same shape as its identity handler
 * deriving a contact from a customer record.
 */

import type { ObjectSchema } from "./object-schema";
import {
  AGREEMENT_ITEM_TYPES,
  AGREEMENT_STATUSES,
  AGREEMENT_TYPES,
  BILLING_MODELS,
  COLLECTION_METHODS,
  DISCOUNT_KINDS,
  DISCOUNT_STATUSES,
  SUBSCRIPTION_BILLING_PERIODS,
} from "./types/common";

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

/**
 * What the customer agreed to.
 *
 * The six canonical fields, in the sense `bootstrap.ts` uses the term: an id,
 * the account, the offering, the type, the status and the effective date. The
 * id is `externalSourceId` and is never mappable; the account and offering are
 * associations the engine resolves; the other three are here.
 */
const AGREEMENT_SCHEMA: ObjectSchema = {
  object: "agreement",
  label: "Agreement",
  fields: [
    // Synthesized for Stripe, which gives a subscription no name at all. See
    // `agreementDisplayName` — without it every subscription is rejected for a
    // missing name on every sync, exactly as unnamed prices would be.
    {
      name: "name",
      label: "Name",
      kind: "string",
      required: true,
      maxLength: 255,
    },
    {
      name: "agreementType",
      label: "Agreement type",
      kind: "enum",
      enumValues: AGREEMENT_TYPES,
      maxLength: 20,
    },
    {
      name: "status",
      label: "Status",
      kind: "enum",
      enumValues: AGREEMENT_STATUSES,
      maxLength: 20,
    },
    // When the agreement began, as against when we first saw it. A provider
    // that reports neither leaves this null rather than defaulting to now,
    // which would invent a start date.
    { name: "effectiveDate", label: "Effective date", kind: "date" },
    { name: "endDate", label: "End date", kind: "date" },
    {
      name: "currency",
      label: "Currency",
      kind: "string",
      maxLength: 10,
    },
    // A plain mappable string, deliberately not `readOnly` and deliberately not
    // a JSON field in the schema: handlers serialize their provider bag to a
    // JSON string and a default rule maps it, exactly as `agreement_name` is
    // synthesized by the Stripe handler (defaults.ts:142). Read-only is
    // reserved for engine-resolved association ids, which this is not.
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    // Both derived by the sync engine from the provider's own ids, as
    // `contact.associatedCustomerId` and `offering.associatedProductId` are.
    // Offering them as mapping targets would invite a foreign id into a column
    // holding our internal UUIDs.
    {
      name: "associatedCustomerId",
      label: "Associated customer",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedOfferingId",
      label: "Associated offering",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Recurring-billing detail for an agreement of type `subscription`.
 *
 * Note there is no `name` here, and that is deliberate rather than an
 * oversight: this row extends exactly one agreement, which already has one.
 * A name of its own could only ever be a copy that drifts.
 *
 * The period dates are the reason this object exists at all. "Which customers
 * renew this month" is the question a subscription is synced to answer, and it
 * cannot be asked of a JSON blob or of a column that half the table's rows have
 * to leave null.
 */
const SUBSCRIPTION_SCHEMA: ObjectSchema = {
  object: "subscription",
  label: "Subscription",
  fields: [
    { name: "currentPeriodStart", label: "Current period start", kind: "date" },
    { name: "currentPeriodEnd", label: "Current period end", kind: "date" },
    { name: "trialStartsAt", label: "Trial starts at", kind: "date" },
    { name: "trialEndsAt", label: "Trial ends at", kind: "date" },
    // Distinct from `agreement.endDate`: this is when cancellation was
    // *requested*, which can precede the end of the paid period by a month.
    { name: "canceledAt", label: "Canceled at", kind: "date" },
    // When the subscription actually stops — Chargebee's `cancel_at`. Distinct
    // from `canceledAt` (requested) and from `agreement.endDate` (the shared
    // node's view).
    { name: "cancelAt", label: "Cancels at", kind: "date" },
    // The next scheduled renewal — the date that answers "what renews next".
    { name: "nextBillingAt", label: "Next billing at", kind: "date" },
    {
      name: "cancelAtPeriodEnd",
      label: "Cancels at period end",
      kind: "boolean",
    },
    // The cadence of the *primary* line. See the column comment: a subscription
    // whose lines carry different intervals has no single cadence, and the
    // handler leaves this null there.
    {
      name: "billingPeriod",
      label: "Billing period",
      kind: "enum",
      enumValues: SUBSCRIPTION_BILLING_PERIODS,
      maxLength: 20,
    },
    { name: "billingPeriodCount", label: "Billing period count", kind: "number" },
    {
      name: "collectionMethod",
      label: "Collection method",
      kind: "enum",
      enumValues: COLLECTION_METHODS,
    },
    { name: "quantity", label: "Quantity", kind: "number" },
    // How many priced lines the subscription carries. Stored because only the
    // first is linked to an offering, and a count of 3 against one link is the
    // only thing on the row that says so.
    { name: "itemCount", label: "Item count", kind: "number" },
    // Mappable string, serialized by the handler; see `agreement.providerMetadata`.
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    {
      name: "associatedAgreementId",
      label: "Associated agreement",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Agreement item
// ---------------------------------------------------------------------------

/**
 * One priced line on an agreement.
 *
 * The third object under this function and the first that is **many per source
 * record**: a subscription yields one agreement, one subscription and as many
 * items as it has lines. Everything above resolves one table per target object
 * from one record; this one fans out, which is why the Stripe handler maps its
 * page differently for this object alone.
 *
 * Note what is *not* here. No name — a line is described by the offering it
 * points at, and a copied one could only drift. No amount and no total: the
 * price it points at holds the money, and a subscription's true total is the
 * provider's to state rather than ours to sum. This object is the *selection*,
 * not the thing selected.
 */
const AGREEMENT_ITEM_SCHEMA: ObjectSchema = {
  object: "agreementItem",
  // "Line item" rather than "Agreement item": the qualifier keeps the union
  // member honest about which table a row lands in, and a user reading the
  // mapping editor is already inside the Agreement function.
  label: "Line item",
  fields: [
    { name: "quantity", label: "Quantity", kind: "number" },
    // The provider's own ordering, not a rank. See the column comment.
    { name: "position", label: "Position", kind: "number" },
    {
      name: "itemType",
      label: "Line type",
      kind: "enum",
      enumValues: AGREEMENT_ITEM_TYPES,
      maxLength: 20,
    },
    // How the provider says this line is priced. Null means "not told" — see
    // the column comment, which is why Chargebee leaves it null today.
    {
      name: "billingModel",
      label: "Billing model",
      kind: "enum",
      enumValues: BILLING_MODELS,
      maxLength: 20,
    },
    // What the provider says this line bills per unit for this subscription,
    // in minor units. Chargebee's always-present `unit_price`; null on Stripe.
    { name: "unitPriceMinor", label: "Unit price (minor units)", kind: "number" },
    { name: "freeQuantity", label: "Free quantity", kind: "number" },
    { name: "billingCycles", label: "Billing cycles", kind: "number" },
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    // All three derived by the engine from the provider's own ids, as every
    // other association id on this function is.
    {
      name: "associatedAgreementId",
      label: "Associated agreement",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedOfferingId",
      label: "Associated offering",
      kind: "string",
      readOnly: true,
    },
    // The third edge, and the one that says *which* of the offering's prices
    // this line went for. It normally agrees with the offering beside it — both
    // are read off the same nested price — but a line whose offering resolved
    // and whose price did not is a state the schema can hold, and the writer
    // warns into this field when it happens.
    {
      name: "associatedPriceId",
      label: "Associated price",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Agreement entitlement
// ---------------------------------------------------------------------------

/**
 * The *effective* entitlement one agreement confers.
 *
 * The fifth object under this function and the second that is many per source
 * record, but its fan-out is different from `agreementItem`'s: lines come
 * inline on the subscription record, while Chargebee's effective entitlements
 * need a per-subscription request. The handler fans out over subscriptions for
 * this object alone.
 *
 * It mirrors `catalog-schema.ts`'s `Entitlement` field for field — the two
 * levels should read alike — with two additions the catalog baseline cannot
 * need: whether the value was overridden and whether the feature is enabled at
 * all. Nullability is left at the column's: the provider says nothing and the
 * reader shows nothing.
 */
const AGREEMENT_ENTITLEMENT_SCHEMA: ObjectSchema = {
  object: "agreementEntitlement",
  label: "Agreement entitlement",
  fields: [
    { name: "value", label: "Value", kind: "string", maxLength: 255 },
    { name: "valueName", label: "Value name", kind: "string", maxLength: 255 },
    { name: "limitValue", label: "Limit value", kind: "number" },
    { name: "isOverride", label: "Overrides baseline", kind: "boolean" },
    { name: "isEnabled", label: "Enabled", kind: "boolean" },
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    {
      name: "associatedAgreementId",
      label: "Associated agreement",
      kind: "string",
      readOnly: true,
    },
    {
      name: "associatedFeatureId",
      label: "Associated feature",
      kind: "string",
      readOnly: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Agreement discount
// ---------------------------------------------------------------------------

/**
 * A discount stated on one agreement.
 *
 * The sixth object under this function, and the third that is many per source
 * record.
 *
 * There is no amount *computed* from the discount and no link to the lines it
 * touches: a discount is an assertion the provider made, and summing it is the
 * arithmetic `AgreementItem`'s header refuses.
 *
 * `externalCouponId` is mappable, unlike `associatedPriceId` and its siblings.
 * Those are read-only because they hold *our* internal UUIDs, resolved by the
 * engine from the provider's id, so offering them invites a foreign id into the
 * wrong column. This field holds a provider id *as a provider id* — there is no
 * coupon table to resolve it against — so mapping it is exactly what it is for.
 */
const AGREEMENT_DISCOUNT_SCHEMA: ObjectSchema = {
  object: "agreementDiscount",
  label: "Discount",
  fields: [
    {
      name: "externalCouponId",
      label: "Coupon id (provider)",
      kind: "string",
      maxLength: 255,
    },
    { name: "label", label: "Label", kind: "string", maxLength: 255 },
    {
      name: "kind",
      label: "Kind",
      kind: "enum",
      enumValues: DISCOUNT_KINDS,
      maxLength: 20,
    },
    { name: "percentOff", label: "Percent off", kind: "number" },
    { name: "amountOffMinor", label: "Amount off (minor units)", kind: "number" },
    {
      name: "status",
      label: "Status",
      kind: "enum",
      enumValues: DISCOUNT_STATUSES,
      maxLength: 20,
    },
    { name: "startsAt", label: "Starts at", kind: "date" },
    { name: "endsAt", label: "Ends at", kind: "date" },
    {
      name: "providerMetadata",
      label: "Provider metadata (JSON)",
      kind: "string",
      maxLength: 1000,
    },
    {
      name: "associatedAgreementId",
      label: "Associated agreement",
      kind: "string",
      readOnly: true,
    },
  ],
};

export const AGREEMENT_OBJECT_SCHEMA = {
  agreement: AGREEMENT_SCHEMA,
  subscription: SUBSCRIPTION_SCHEMA,
  agreementItem: AGREEMENT_ITEM_SCHEMA,
  agreementEntitlement: AGREEMENT_ENTITLEMENT_SCHEMA,
  agreementDiscount: AGREEMENT_DISCOUNT_SCHEMA,
} as const;
