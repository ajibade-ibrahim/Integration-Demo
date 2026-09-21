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
import { AGREEMENT_STATUSES, AGREEMENT_TYPES } from "./types/common";

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
    { name: "trialEndsAt", label: "Trial ends at", kind: "date" },
    // Distinct from `agreement.endDate`: this is when cancellation was
    // *requested*, which can precede the end of the paid period by a month.
    { name: "canceledAt", label: "Canceled at", kind: "date" },
    {
      name: "cancelAtPeriodEnd",
      label: "Cancels at period end",
      kind: "boolean",
    },
    {
      name: "collectionMethod",
      label: "Collection method",
      kind: "string",
      maxLength: 50,
    },
    { name: "quantity", label: "Quantity", kind: "number" },
    // How many priced lines the subscription carries. Stored because only the
    // first is linked to an offering, and a count of 3 against one link is the
    // only thing on the row that says so.
    { name: "itemCount", label: "Item count", kind: "number" },
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
} as const;
