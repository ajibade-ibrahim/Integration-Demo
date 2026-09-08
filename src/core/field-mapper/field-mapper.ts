/**
 * Field mapper — validation, application, and serialization of mapping rules.
 */

import {
  CUSTOM_FIELD_PATTERN,
  MAX_CUSTOM_FIELD_VALUE_LENGTH,
  resolveTargetField,
} from "../identity-schema";
import {
  isTargetObject,
  type RawRecord,
  type TargetObject,
} from "../types/common";
import {
  isFieldTransform,
  type FieldMappingConfig,
  type FieldMappingRule,
  type MappedRecord,
  type MappingViolation,
  type SerializedMappingConfig,
  type ValidationResult,
} from "../types/mapping";
import { applyTransform } from "./transforms";

export const MAPPING_SCHEMA_VERSION = 1;

const MAX_PATH_LENGTH = 255;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a rule set against the identity schema.
 *
 * Every rule is checked and every violation reported — the caller shows the
 * user all their mistakes at once rather than one per save attempt.
 */
export function validateMappings(
  rules: readonly FieldMappingRule[]
): ValidationResult {
  const violations: MappingViolation[] = [];
  const seen = new Set<string>();

  rules.forEach((rule, index) => {
    // --- target object ---
    if (!isTargetObject(rule.targetObject)) {
      violations.push({
        index,
        field: "targetObject",
        message: `'${String(rule.targetObject)}' is not a known target object`,
      });
      return; // Everything below depends on a valid object.
    }

    // --- source path ---
    const source = rule.sourceFieldPath;
    if (typeof source !== "string" || source.trim() === "") {
      violations.push({
        index,
        field: "sourceFieldPath",
        message: "Source field path is required",
      });
    } else if (source.length > MAX_PATH_LENGTH) {
      violations.push({
        index,
        field: "sourceFieldPath",
        message: `Source field path exceeds ${MAX_PATH_LENGTH} characters`,
      });
    }

    // --- target path ---
    const target = rule.targetFieldPath;
    if (typeof target !== "string" || target.trim() === "") {
      violations.push({
        index,
        field: "targetFieldPath",
        message: "Target field path is required",
      });
    } else if (target.length > MAX_PATH_LENGTH) {
      violations.push({
        index,
        field: "targetFieldPath",
        message: `Target field path exceeds ${MAX_PATH_LENGTH} characters`,
      });
    } else {
      const resolved = resolveTargetField(rule.targetObject, target);

      if (resolved === undefined) {
        // Name the object explicitly: mapping a contact field onto a customer
        // is the most likely mistake and the message should say so.
        violations.push({
          index,
          field: "targetFieldPath",
          message: `'${target}' is not a field on ${rule.targetObject}`,
        });
      } else if (resolved !== "customField" && resolved.readOnly === true) {
        violations.push({
          index,
          field: "targetFieldPath",
          message: `'${target}' is derived by the sync engine and cannot be mapped`,
        });
      }

      // --- duplicate targets ---
      const dedupeKey = `${rule.targetObject}.${target}`;
      if (seen.has(dedupeKey)) {
        violations.push({
          index,
          field: "targetFieldPath",
          message: `'${dedupeKey}' is mapped more than once`,
        });
      }
      seen.add(dedupeKey);
    }

    // --- transform ---
    if (!isFieldTransform(rule.transform)) {
      violations.push({
        index,
        field: "transform",
        message: `'${String(rule.transform)}' is not a known transform`,
      });
    }
  });

  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Read a dot-notation path out of a nested object.
 *
 * Own properties only. Source paths come from user-editable mappings, so a path
 * like `constructor` or `__proto__` would otherwise reach up the prototype
 * chain and pull back a function or the prototype itself.
 */
export function readPath(record: RawRecord, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Coerce a provider value to the string form our columns hold. */
function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "function" || typeof value === "symbol") return null;
  // Objects and arrays: JSON rather than "[object Object]".
  try {
    // JSON.stringify yields undefined for some inputs, which must not escape
    // as a non-null value — every caller below relies on the null check.
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply every rule for one target object to one source record.
 *
 * Each rule is evaluated for each record — a rule whose source field is absent
 * writes null rather than being skipped, so the shape of the output does not
 * depend on which fields a particular record happened to carry.
 */
export function applyMappings(
  rules: readonly FieldMappingRule[],
  object: TargetObject,
  source: RawRecord
): MappedRecord {
  const fields: Record<string, string | null> = {};
  const customFields: Record<string, string> = {};

  for (const rule of rules) {
    if (rule.targetObject !== object) continue;

    const raw = stringify(readPath(source, rule.sourceFieldPath));
    const value = raw === null ? null : applyTransform(rule.transform, raw);

    if (CUSTOM_FIELD_PATTERN.test(rule.targetFieldPath)) {
      // Custom fields are a JSON map; a null has no key to hold it.
      if (value !== null && value !== "") {
        const key = rule.targetFieldPath.slice("customFields.".length);
        customFields[key] = value.slice(0, MAX_CUSTOM_FIELD_VALUE_LENGTH);
      }
      continue;
    }

    fields[rule.targetFieldPath] = value;
  }

  return { object, fields, customFields };
}

/** Source paths a handler needs to request, grouped by object. */
export function requestedSourcePaths(
  rules: readonly FieldMappingRule[]
): Map<TargetObject, string[]> {
  const grouped = new Map<TargetObject, string[]>();
  for (const rule of rules) {
    const list = grouped.get(rule.targetObject) ?? [];
    if (!list.includes(rule.sourceFieldPath)) list.push(rule.sourceFieldPath);
    grouped.set(rule.targetObject, list);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeMappings(
  config: FieldMappingConfig
): SerializedMappingConfig {
  return {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    integrationId: config.integrationId,
    rules: config.rules.map((r) => ({ ...r })),
  };
}

/**
 * Rebuild a config from its stored form.
 *
 * @throws On an unknown schema version or a structurally invalid payload,
 *   leaving any currently active mapping untouched.
 */
export function deserializeMappings(data: unknown): FieldMappingConfig {
  if (data === null || typeof data !== "object") {
    throw new Error("Mapping config: payload is not an object");
  }
  const raw = data as Partial<SerializedMappingConfig>;

  if (raw.schemaVersion !== MAPPING_SCHEMA_VERSION) {
    throw new Error(
      `Mapping config: unsupported schema version ${String(raw.schemaVersion)}`
    );
  }
  if (typeof raw.integrationId !== "string" || raw.integrationId.trim() === "") {
    throw new Error("Mapping config: missing integrationId");
  }
  if (!Array.isArray(raw.rules)) {
    throw new Error("Mapping config: rules must be an array");
  }

  const rules: FieldMappingRule[] = raw.rules.map((rule, index) => {
    if (rule === null || typeof rule !== "object") {
      throw new Error(`Mapping config: rule ${index} is not an object`);
    }
    const r = rule as Partial<FieldMappingRule>;

    if (typeof r.sourceFieldPath !== "string" || r.sourceFieldPath === "") {
      throw new Error(`Mapping config: rule ${index} has no sourceFieldPath`);
    }
    if (typeof r.targetFieldPath !== "string" || r.targetFieldPath === "") {
      throw new Error(`Mapping config: rule ${index} has no targetFieldPath`);
    }
    if (!isTargetObject(r.targetObject)) {
      throw new Error(`Mapping config: rule ${index} has no valid targetObject`);
    }
    if (!isFieldTransform(r.transform)) {
      throw new Error(`Mapping config: rule ${index} has no valid transform`);
    }
    return {
      sourceFieldPath: r.sourceFieldPath,
      targetObject: r.targetObject,
      targetFieldPath: r.targetFieldPath,
      transform: r.transform,
    };
  });

  return { integrationId: raw.integrationId, rules };
}
