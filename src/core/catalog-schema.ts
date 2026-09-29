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
    { name: "active", label: "Active", kind: "boolean" },
  ],
};

const OFFERING_SCHEMA: ObjectSchema = {
  object: "offering",
  label: "Offering",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    {
      name: "description",
      label: "Description",
      kind: "string",
      maxLength: 1000,
    },
    { name: "active", label: "Active", kind: "boolean" },
    {
      name: "associatedProductId",
      label: "Associated product",
      kind: "string",
      readOnly: true,
    },
  ],
};

const PRICE_SCHEMA: ObjectSchema = {
  object: "price",
  label: "Price",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    { name: "amountMinor", label: "Amount (minor units)", kind: "number" },
    {
      name: "currency",
      label: "Currency",
      kind: "string",
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
    {
      name: "associatedOfferingId",
      label: "Associated offering",
      kind: "string",
      readOnly: true,
    },
  ],
};

const FEATURE_SCHEMA: ObjectSchema = {
  object: "feature",
  label: "Feature",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    {
      name: "lookupKey",
      label: "Lookup key",
      kind: "string",
      maxLength: 255,
    },
    {
      name: "externalFeatureId",
      label: "Feature ID (provider's own)",
      kind: "string",
      maxLength: 255,
    },
    {
      name: "isMetered",
      label: "Is metered",
      kind: "boolean",
    },
    {
      name: "associatedOfferingId",
      label: "Associated offering",
      kind: "string",
      readOnly: true,
    },
  ],
};

export const CATALOG_SCHEMA = {
  product: PRODUCT_SCHEMA,
  offering: OFFERING_SCHEMA,
  price: PRICE_SCHEMA,
  feature: FEATURE_SCHEMA,
} as const;
