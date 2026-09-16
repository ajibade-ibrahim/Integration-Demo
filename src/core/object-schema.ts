/**
 * The composed target schema: every internal object a mapping rule may write
 * to, and which of them each function owns.
 *
 * This file is the single source of truth for four consumers:
 *   1. mapping validation (`src/core/field-mapper`),
 *   2. the target dropdown in the mapping editor UI,
 *   3. record validation in the sync engine,
 *   4. survivorship in identity resolution.
 * They read the same definitions, so they cannot drift apart.
 *
 * Target paths are **object-qualified** — `customer.name`, `offering.currency`.
 * A flat namespace shared between objects would let `contact.email` be mapped
 * onto a customer record and validate cleanly, which is exactly the bug this
 * structure exists to prevent.
 *
 * The per-function split is the other half of that guarantee. `TARGET_OBJECTS`
 * in `types/common.ts` is flat and global, because `FieldMapping.targetObject`
 * is a stored column and a saved rule has to stay recognisable whichever
 * function owns it. *Ownership* is here: without it, a `catalog` rule set could
 * contain customer rules, validate cleanly, and write nothing — a mapping that
 * silently does nothing being considerably worse than one that is refused.
 */

import { CATALOG_SCHEMA } from "./catalog-schema";
import {
  CROSS_REF_OBJECTS,
  IDENTITY_SCHEMA,
  crossRefProviderName,
} from "./identity-schema";
import { providerRegistry } from "./registries/provider-registry";
import { TARGET_OBJECTS, type TargetObject } from "./types/common";

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/**
 * How a field's value is meant to be read.
 *
 * Advisory rather than enforced: the field mapper stringifies every value, and
 * each writer parses the fields it owns explicitly (`parseDate`, `parseInteger`
 * and friends in `record-writer.ts`). What `kind` drives is the mapping
 * editor's presentation and the reader's expectations, which is why widening it
 * is safe.
 */
export type FieldKind =
  | "string"
  | "email"
  | "date"
  | "enum"
  | "number"
  | "boolean";

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
   * Derived by the sync engine, not user-mappable. `associatedCustomerId` and
   * `associatedProductId` are resolved from the provider's own foreign id —
   * offering them as mapping targets would invite users to map a foreign id
   * into a field holding our internal UUIDs.
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
// The composed registry
// ---------------------------------------------------------------------------

export const OBJECT_SCHEMAS: Readonly<Record<TargetObject, ObjectSchema>> = {
  ...IDENTITY_SCHEMA,
  ...CATALOG_SCHEMA,
};

/**
 * Objects each function writes, **in write order**.
 *
 * The order is not presentational. An offering resolves its product through an
 * index built while products are written, exactly as a contact resolves its
 * customer — so "products before offerings" and "customers before contacts" are
 * the same fact, and the sync engine reads it from here rather than hardcoding
 * a sequence per function.
 *
 * Function names are literals rather than imports from `bootstrap.ts`: that
 * module imports every provider, and every provider reaches this schema, so the
 * import would close a cycle. `tests/unit/catalog-schema.test.ts` pins each
 * registered function against this map, which is what keeps the literals
 * honest.
 */
const FUNCTION_OBJECTS: Readonly<Record<string, readonly TargetObject[]>> = {
  identity: ["customer", "contact"],
  catalog: ["product", "offering"],
};

/**
 * The objects a function may write, in write order.
 *
 * An unregistered function, or one declared without a handler, yields an empty
 * list rather than throwing — `providerNamesForFunction` answers the same way,
 * and a function that is declared but unbuilt is a reachable state here by
 * design.
 */
export function objectsForFunction(
  functionName: string
): readonly TargetObject[] {
  return FUNCTION_OBJECTS[functionName] ?? [];
}

/** Schemas for the objects a function may write, in write order. */
export function schemasForFunction(
  functionName: string
): readonly ObjectSchema[] {
  return objectsForFunction(functionName).map((o) => OBJECT_SCHEMAS[o]);
}

/** Whether a function may write to a given object. */
export function functionOwnsObject(
  functionName: string,
  object: TargetObject
): boolean {
  return objectsForFunction(functionName).includes(object);
}

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

  return OBJECT_SCHEMAS[object].fields.find((f) => f.name === fieldPath);
}

/** Target fields a user may map to — everything except read-only fields. */
export function mappableFields(
  object: TargetObject
): readonly FieldDefinition[] {
  return OBJECT_SCHEMAS[object].fields.filter((f) => f.readOnly !== true);
}

/** Every object schema, for UI iteration that is not function-scoped. */
export function allObjectSchemas(): readonly ObjectSchema[] {
  return TARGET_OBJECTS.map((o) => OBJECT_SCHEMAS[o]);
}
