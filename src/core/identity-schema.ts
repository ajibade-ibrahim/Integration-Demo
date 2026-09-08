/**
 * The internal identity schema: the target fields a mapping rule may write to.
 *
 * This object is the single source of truth for three consumers:
 *   1. mapping validation (`src/core/field-mapper`),
 *   2. the target dropdown in the mapping editor UI,
 *   3. record validation in the sync engine.
 * They read the same definitions, so they cannot drift apart.
 *
 * Target paths are **object-qualified** — `customer.name`, `contact.email`.
 * A flat namespace shared between the two objects would let `contact.email` be
 * mapped onto a customer record and validate cleanly, which is exactly the bug
 * this structure exists to prevent.
 */

import {
  CUSTOMER_TYPES,
  TARGET_OBJECTS,
  type CustomerType,
  type TargetObject,
} from "./types/common";

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export type FieldKind = "string" | "email" | "date" | "enum";

export interface FieldDefinition {
  /** Unqualified field name, e.g. "domain". */
  readonly name: string;
  /** Human label for the mapping UI. */
  readonly label: string;
  readonly kind: FieldKind;
  /** Rejecting the record when absent or empty. */
  readonly required?: boolean;
  readonly maxLength?: number;
  /** Permitted values when `kind` is "enum". */
  readonly enumValues?: readonly string[];
  /**
   * Derived by the sync engine, not user-mappable. `associatedCustomerId` is
   * resolved from the provider's external company id — offering it as a
   * mapping target would invite users to map a foreign id into a field holding
   * our internal UUIDs.
   */
  readonly readOnly?: boolean;
}

export interface ObjectSchema {
  readonly object: TargetObject;
  readonly label: string;
  readonly fields: readonly FieldDefinition[];
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const CUSTOMER_SCHEMA: ObjectSchema = {
  object: "customer",
  label: "Customer",
  fields: [
    { name: "name", label: "Name", kind: "string", required: true, maxLength: 255 },
    { name: "domain", label: "Domain", kind: "string", maxLength: 253 },
    { name: "industry", label: "Industry", kind: "string", maxLength: 100 },
    { name: "createDate", label: "Create date", kind: "date" },
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

export const IDENTITY_SCHEMA: Readonly<Record<TargetObject, ObjectSchema>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

/** `customFields.<key>` — up to 100 alphanumeric/underscore characters. */
export const CUSTOM_FIELD_PATTERN = /^customFields\.[a-zA-Z0-9_]{1,100}$/;

export const MAX_CUSTOM_FIELDS = 50;
export const MAX_CUSTOM_FIELD_VALUE_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Resolve a target field within one object's schema.
 *
 * @returns The definition, `"customField"` for a valid `customFields.<key>`
 *   path, or `undefined` if the path names nothing in this object.
 */
export function resolveTargetField(
  object: TargetObject,
  fieldPath: string
): FieldDefinition | "customField" | undefined {
  if (CUSTOM_FIELD_PATTERN.test(fieldPath)) return "customField";
  return IDENTITY_SCHEMA[object].fields.find((f) => f.name === fieldPath);
}

/** Target fields a user may map to — everything except read-only fields. */
export function mappableFields(object: TargetObject): readonly FieldDefinition[] {
  return IDENTITY_SCHEMA[object].fields.filter((f) => f.readOnly !== true);
}

/** Every object schema, for UI iteration. */
export function allObjectSchemas(): readonly ObjectSchema[] {
  return TARGET_OBJECTS.map((o) => IDENTITY_SCHEMA[o]);
}

export type { CustomerType, TargetObject };
