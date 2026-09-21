/**
 * Field mapping persistence, scoped by (integration, function).
 */

import { prisma } from "@/lib/prisma";
import { validateMappings } from "../field-mapper/field-mapper";
import type { TargetObject } from "../types/common";
import type { FieldMappingRule, FieldTransform } from "../types/mapping";

export async function findMappings(
  integrationId: string,
  functionName: string
): Promise<FieldMappingRule[]> {
  const rows = await prisma.fieldMapping.findMany({
    where: { integrationId, functionName },
    orderBy: [{ targetObject: "asc" }, { targetFieldPath: "asc" }],
  });

  return rows.map((row) => ({
    sourceFieldPath: row.sourceFieldPath,
    targetObject: row.targetObject as TargetObject,
    targetFieldPath: row.targetFieldPath,
    transform: row.transform as FieldTransform,
  }));
}

/**
 * Replace the rule set for one (integration, function).
 *
 * Validated first and written in a transaction: a config containing any invalid
 * rule must not be partially persisted, and the previous rules must survive a
 * rejected save intact.
 *
 * @throws If validation fails, naming every invalid rule.
 */
export async function saveMappings(
  integrationId: string,
  functionName: string,
  rules: readonly FieldMappingRule[]
): Promise<void> {
  const result = validateMappings(functionName, rules);
  if (!result.valid) {
    const detail = result.violations
      .map((v) => `rule ${v.index} (${v.field}): ${v.message}`)
      .join("; ");
    throw new Error(`Invalid field mapping: ${detail}`);
  }

  await prisma.$transaction([
    prisma.fieldMapping.deleteMany({ where: { integrationId, functionName } }),
    prisma.fieldMapping.createMany({
      data: rules.map((rule) => ({
        integrationId,
        functionName,
        targetObject: rule.targetObject,
        sourceFieldPath: rule.sourceFieldPath,
        targetFieldPath: rule.targetFieldPath,
        transform: rule.transform,
      })),
    }),
  ]);
}

export async function countMappings(
  integrationId: string,
  functionName: string
): Promise<number> {
  return prisma.fieldMapping.count({ where: { integrationId, functionName } });
}

/**
 * Write a starting rule set, but only if none exists.
 *
 * Used to seed suggested defaults on first connect. Returning early when rules
 * are already present is what stops it from trampling a user's edits if it is
 * ever called again.
 */
export async function seedMappingsIfEmpty(
  integrationId: string,
  functionName: string,
  rules: readonly FieldMappingRule[]
): Promise<boolean> {
  if (rules.length === 0) return false;
  if ((await countMappings(integrationId, functionName)) > 0) return false;

  await saveMappings(integrationId, functionName, rules);
  return true;
}
