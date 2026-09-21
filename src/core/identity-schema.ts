/**
 * The identity schema: the target fields an `identity` mapping rule may write
 * to, plus the cross-reference targets that only make sense on a customer.
 *
 * One of two schema files — `catalog-schema.ts` is the other — composed into a
 * single registry by `object-schema.ts`, which is what mapping validation, the
 * target dropdown, the sync engine and survivorship all read. Lookups live
 * there rather than here, so a consumer does not have to know which file a
 * given object was declared in.
 *
 * Target paths are **object-qualified** — `customer.name`, `contact.email`.
 * A flat namespace shared between the two objects would let `contact.email` be
 * mapped onto a customer record and validate cleanly, which is exactly the bug
 * that structure exists to prevent.
 */

import type { ObjectSchema } from "./object-schema";
import { CUSTOMER_TYPES, type CustomerType, type TargetObject } from "./types/common";

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const CUSTOMER_SCHEMA: ObjectSchema = {
  object: "customer",
  label: "Customer",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    { name: "domain", label: "Domain", kind: "string", maxLength: 253 },
    // A first-class field rather than a custom one because identity resolution
    // matches on it, and `customFields` is a serialized JSON string column —
    // not queryable, not indexable. Stripe and Metrifox are the two providers
    // that carry an account-level address; the CRMs carry none, so this is
    // frequently null and that is expected.
    { name: "email", label: "Email", kind: "email", maxLength: 254 },
    { name: "industry", label: "Industry", kind: "string", maxLength: 100 },
    {
      name: "createDate",
      label: "Create date",
      kind: "date",
      conflictPolicy: "earliest",
    },
    {
      name: "type",
      label: "Type",
      kind: "enum",
      enumValues: CUSTOMER_TYPES,
      maxLength: 50,
    },
  ],
};

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

const CONTACT_SCHEMA: ObjectSchema = {
  object: "contact",
  label: "Contact",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    { name: "email", label: "Email", kind: "email", maxLength: 254 },
    { name: "jobTitle", label: "Job title", kind: "string", maxLength: 255 },
    { name: "phone", label: "Phone", kind: "string", maxLength: 50 },
    {
      name: "associatedCustomerId",
      label: "Associated customer",
      kind: "string",
      readOnly: true,
    },
  ],
};

export const IDENTITY_SCHEMA = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
} as const;

/**
 * The objects the identity function writes.
 *
 * Narrower than `TargetObject`, and worth naming separately: the identity
 * handlers hold per-object lookup tables — HubSpot object paths, Salesforce
 * sObject names, required field lists — that cover these two and nothing else.
 * Typing those against the full union would force a meaningless entry for every
 * object some other function happens to own.
 */
export type IdentityObject = keyof typeof IDENTITY_SCHEMA;

export function isIdentityObject(v: TargetObject): v is IdentityObject {
  return v === "customer" || v === "contact";
}

// ---------------------------------------------------------------------------
// Cross-integration references
// ---------------------------------------------------------------------------

/**
 * `crossRef.<provider>` — this record names the same company's id in another
 * provider.
 *
 * The mapping target for the join the governing spec calls for and no API
 * offers: Metrifox's `payments_stripe_customers` relates a Metrifox customer to
 * a Stripe customer, but the Metrifox connector cannot fetch it. When the
 * foreign id happens to ride on a record the connector *already* reads, a
 * mapping rule is all it takes — so this reuses the mapping editor,
 * `validateMappings`, the transforms and the source dropdown wholesale, and
 * adds no UI.
 *
 * Deliberately not `customFields.stripe_customer_id`. A custom field is a
 * serialized JSON string: not queryable, not indexable, and indistinguishable
 * from any other opaque note the user chose to keep. A cross-reference has to
 * be found by value, which is the same argument that promoted `email` to a real
 * column.
 *
 * Character class matches provider names, which are lowercase identifiers.
 */
export const CROSS_REF_PATTERN = /^crossRef\.([a-z0-9][a-z0-9_-]{0,49})$/;

/**
 * The provider named by a `crossRef.<provider>` path, whether or not it is
 * registered.
 *
 * Shape only. Kept separate from `resolveTargetField` so a rule naming an
 * unknown provider can be told apart from a rule naming nothing at all, and
 * reported as "'nonsense' is not a known provider" instead of the misleading
 * "not a field on customer".
 */
export function crossRefProviderName(fieldPath: string): string | undefined {
  return CROSS_REF_PATTERN.exec(fieldPath)?.[1];
}

/**
 * Objects a cross-reference may be mapped onto.
 *
 * Customer only. A cross-reference is a claim that two records are the same
 * *company*; person-level identity — the spec's `USER` entity — is a separate
 * problem with its own match rules, and offering the target before those exist
 * would accept data nothing reads.
 */
export const CROSS_REF_OBJECTS: readonly TargetObject[] = ["customer"];

export type { CustomerType, TargetObject };
