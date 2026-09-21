/**
 * The catalog schema: the target fields a `catalog` mapping rule may write to.
 *
 * Sibling of `identity-schema.ts`, and read through the same three consumers —
 * mapping validation, the target dropdown, record validation — via the composed
 * registry in `object-schema.ts`.
 *
 * The catalog needs no customer. A product exists whether or not anyone has
 * bought it, which is why this is its own function rather than a wing of
 * identity: the two share no record, no association and no ordering constraint.
 */

import type { ObjectSchema } from "./object-schema";
import { BILLING_INTERVALS } from "./types/common";

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

const PRODUCT_SCHEMA: ObjectSchema = {
  object: "product",
  label: "Product",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    {
      name: "description",
      label: "Description",
      kind: "string",
      maxLength: 1000,
    },
    // Stripe archives rather than deletes, and an archived product still comes
    // back from `/v1/products`. Without this the catalog silently accumulates
    // things nobody can buy, indistinguishable from things they can.
    { name: "active", label: "Active", kind: "boolean" },
  ],
};

// ---------------------------------------------------------------------------
// Offering
// ---------------------------------------------------------------------------

/**
 * A priced, purchasable configuration of a product.
 *
 * `amountMinor` is minor units — cents, pence, yen — and an integer, never a
 * float. That is not a style preference: 0.1 + 0.2 is not 0.3 in a double, and
 * a catalog that cannot add two prices correctly is worse than one that shows
 * nothing. Every provider worth integrating already reports money this way for
 * the same reason.
 *
 * The currency is held beside it rather than folded into a formatted string,
 * because an amount without its currency is not a number that means anything —
 * 4900 is $49 or ¥4,900 depending on a field this record must therefore
 * carry.
 */
const OFFERING_SCHEMA: ObjectSchema = {
  object: "offering",
  label: "Offering",
  fields: [
    // Frequently synthesized rather than read: most real price records have no
    // name of their own. See `offeringDisplayName` in the Stripe handler.
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    { name: "amountMinor", label: "Amount (minor units)", kind: "number" },
    {
      name: "currency",
      label: "Currency",
      kind: "string",
      // ISO 4217 is three characters. The allowance is for providers that
      // return something longer rather than for a longer code existing.
      maxLength: 10,
    },
    {
      name: "interval",
      label: "Billing interval",
      kind: "enum",
      enumValues: BILLING_INTERVALS,
      maxLength: 20,
    },
    { name: "intervalCount", label: "Interval count", kind: "number" },
    { name: "active", label: "Active", kind: "boolean" },
    // Derived by the sync engine from the provider's own product id, exactly as
    // `contact.associatedCustomerId` is. Offering it as a mapping target would
    // invite users to map a foreign id into a field holding our internal UUIDs.
    {
      name: "associatedProductId",
      label: "Associated product",
      kind: "string",
      readOnly: true,
    },
  ],
};

export const CATALOG_SCHEMA = {
  product: PRODUCT_SCHEMA,
  offering: OFFERING_SCHEMA,
} as const;
