/**
 * Read `CustomerAccount.fieldProvenance` across both of its shapes.
 *
 * New writes store a source-evidence object per field. Accounts resolved before
 * that change store a bare integration id string, and must keep rendering: the
 * UI uses the id for its provider chip, and only the record-level detail is
 * missing until the next resolution pass.
 */

import { readJsonRecord } from "../repositories/json-column";
import type {
  FieldAlternative,
  FieldProvenanceEntry,
} from "../types/common";

export function parseFieldProvenance(
  raw: string
): Record<string, FieldProvenanceEntry> {
  const parsed = readJsonRecord(raw);
  const out: Record<string, FieldProvenanceEntry> = {};

  for (const [fieldName, value] of Object.entries(parsed)) {
    const entry = normalizeEntry(value);
    if (entry !== undefined) out[fieldName] = entry;
  }

  return out;
}

function normalizeEntry(value: unknown): FieldProvenanceEntry | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : { integrationId: value };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const integrationId = stringValue(record["integrationId"]);
  if (integrationId === undefined) return undefined;

  const alternatives = Array.isArray(record["alternatives"])
    ? record["alternatives"].flatMap((alternative) => {
        const normalized = normalizeAlternative(alternative);
        return normalized === undefined ? [] : [normalized];
      })
    : [];

  return {
    integrationId,
    ...optionalString(record, "providerName"),
    ...optionalString(record, "instanceLabel"),
    ...optionalString(record, "customerId"),
    ...optionalString(record, "externalSourceId"),
    ...optionalString(record, "evidenceKey"),
    ...optionalString(record, "evidenceValue"),
    ...optionalString(record, "observedAt"),
    ...optionalString(record, "value"),
    ...(alternatives.length === 0 ? {} : { alternatives }),
  };
}

function normalizeAlternative(value: unknown): FieldAlternative | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const integrationId = stringValue(record["integrationId"]);
  const evidenceValue = stringValue(record["value"]);
  const reason = stringValue(record["reason"]);
  if (
    integrationId === undefined ||
    evidenceValue === undefined ||
    reason === undefined
  ) {
    return undefined;
  }

  return {
    integrationId,
    value: evidenceValue,
    reason,
    ...optionalString(record, "providerName"),
    ...optionalString(record, "instanceLabel"),
    ...optionalString(record, "customerId"),
    ...optionalString(record, "externalSourceId"),
    ...optionalString(record, "evidenceKey"),
    ...optionalString(record, "evidenceValue"),
    ...optionalString(record, "observedAt"),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): Record<string, string> {
  const value = stringValue(record[key]);
  return value === undefined ? {} : { [key]: value };
}
