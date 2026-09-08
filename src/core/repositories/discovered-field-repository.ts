/**
 * Discovered field persistence.
 *
 * A cache, not a source of truth: the provider's schema API is authoritative,
 * and this table exists so the mapping editor opens instantly instead of
 * waiting on two round trips to HubSpot or Salesforce every time someone
 * adjusts a dropdown.
 */

import { prisma } from "@/lib/prisma";
import type { TargetObject } from "../types/common";
import type { DiscoveredFieldDef } from "../types/registry";

export interface CachedFields {
  fields: DiscoveredFieldDef[];
  fetchedAt: Date | null;
}

export async function findDiscoveredFields(
  integrationId: string,
  functionName: string,
  object: TargetObject
): Promise<CachedFields> {
  const rows = await prisma.discoveredField.findMany({
    where: { integrationId, functionName, targetObject: object },
    orderBy: { label: "asc" },
  });

  return {
    fields: rows.map((row) => ({
      path: row.path,
      label: row.label,
      type: row.type,
    })),
    // The oldest row bounds the cache age; they are written together, so in
    // practice they share a timestamp.
    fetchedAt:
      rows.length === 0
        ? null
        : rows.reduce<Date>(
            (oldest, row) => (row.fetchedAt < oldest ? row.fetchedAt : oldest),
            rows[0]!.fetchedAt
          ),
  };
}

/**
 * Replace the cached fields for one (integration, function, object).
 *
 * Replacement rather than merge: a property deleted in the provider must
 * disappear from the dropdown, or users keep mapping a field that no longer
 * exists.
 */
export async function replaceDiscoveredFields(
  integrationId: string,
  functionName: string,
  object: TargetObject,
  fields: readonly DiscoveredFieldDef[]
): Promise<void> {
  await prisma.$transaction([
    prisma.discoveredField.deleteMany({
      where: { integrationId, functionName, targetObject: object },
    }),
    prisma.discoveredField.createMany({
      data: fields.map((field) => ({
        integrationId,
        functionName,
        targetObject: object,
        path: field.path,
        label: field.label,
        type: field.type,
      })),
    }),
  ]);
}
