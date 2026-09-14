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

// The one non-schema dependency here, and it earns its place: the set of valid
// `crossRef.<provider>` targets genuinely depends on which providers exist, so
// it is schema in the same sense the field lists are.
import { providerRegistry } from "./registries/provider-registry";
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

/**
 * How identity resolution picks a value when several sources supply one.
 *
 * `highestPriority` — the highest-ranked integration that supplies a non-null
 * value wins. The default, and the rule the provider hierarchy exists to drive.
 *
 * `earliest` — the earliest value across sources wins, regardless of rank.
 * Only `createDate` uses it: if HubSpot saw the company in 2019 and Stripe in
 * 2023, it demonstrably existed in 2019, and letting rank decide would report a
 * date we know to be wrong.
 *
 * Declared here, next to the field it governs, rather than as a branch inside
 * the resolver — this file is already the single source of truth for mapping
 * validation, the target dropdown and record validation, and survivorship is
 * the fourth consumer of the same definitions.
 */
export type FieldConflictPolicy = "highestPriority" | "earliest";

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
  /** Survivorship rule when several integrations supply this field. */
  readonly conflictPolicy?: FieldConflictPolicy;
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
const CROSS_REF_OBJECTS: readonly TargetObject[] = ["customer"];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * What a target path resolves to.
 *
 * A union rather than a boolean so that widening it — as `"crossRef"` did —
 * makes the compiler name every consumer that has to decide what the new kind
 * means, the same way `ProviderAuth` does for credentials.
 */
export type ResolvedTarget = FieldDefinition | "customField" | "crossRef";

/**
 * Resolve a target field within one object's schema.
 *
 * The `crossRef` case is the one that is not purely a function of this file:
 * the provider segment is checked against `providerRegistry`, so
 * `crossRef.nonsense` cannot be saved. That means **bootstrap must have run**
 * for a cross-reference path to validate — which is true of the mapping editor
 * and the sync engine alike, and a test that asserts on one has to call
 * `bootstrap()` first.
 *
 * @returns The definition, `"customField"` for a valid `customFields.<key>`
 *   path, `"crossRef"` for a `crossRef.<registered provider>` path on an object
 *   that accepts one, or `undefined` if the path names nothing usable here.
 */
export function resolveTargetField(
  object: TargetObject,
  fieldPath: string
): ResolvedTarget | undefined {
  if (CUSTOM_FIELD_PATTERN.test(fieldPath)) return "customField";

  const crossRefProvider = crossRefProviderName(fieldPath);
  if (crossRefProvider !== undefined) {
    if (!CROSS_REF_OBJECTS.includes(object)) return undefined;
    return providerRegistry.get(crossRefProvider) === undefined
      ? undefined
      : "crossRef";
  }

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
