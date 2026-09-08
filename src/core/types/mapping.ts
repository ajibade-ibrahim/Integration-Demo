/** Field mapping types. */

import type { TargetObject } from "./common";

export const FIELD_TRANSFORMS = [
  "none",
  "trim",
  "lowercase",
  "domainFromUrl",
  "dateOnly",
] as const;

export type FieldTransform = (typeof FIELD_TRANSFORMS)[number];

export function isFieldTransform(v: unknown): v is FieldTransform {
  return (
    typeof v === "string" && (FIELD_TRANSFORMS as readonly string[]).includes(v)
  );
}

export interface FieldMappingRule {
  /** Dot path into the provider payload, e.g. "properties.domain". */
  sourceFieldPath: string;
  /** Which internal record this rule writes to. */
  targetObject: TargetObject;
  /** Unqualified target field, e.g. "domain" or "customFields.tier". */
  targetFieldPath: string;
  transform: FieldTransform;
}

export interface FieldMappingConfig {
  integrationId: string;
  rules: FieldMappingRule[];
}

export interface SerializedMappingConfig {
  schemaVersion: number;
  integrationId: string;
  rules: FieldMappingRule[];
}

export interface MappingViolation {
  /** Index into the submitted rule list. */
  index: number;
  field: "sourceFieldPath" | "targetFieldPath" | "targetObject" | "transform";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: MappingViolation[];
}

/** The result of applying a rule set to one source record. */
export interface MappedRecord {
  object: TargetObject;
  /** Standard fields. A mapped-but-absent source field yields null. */
  fields: Record<string, string | null>;
  customFields: Record<string, string>;
}
