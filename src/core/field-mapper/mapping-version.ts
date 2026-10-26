/**
 * A stable identity for one function's mapping rules.
 *
 * A stored rule set is mutable: `saveMappings` replaces every row for a
 * function, so "the current mapping" says nothing about the rules a run used
 * before someone edited them. This hash does. It is computed from the rules
 * themselves, not from their row ids or insertion order, so the same content
 * always produces the same version.
 *
 * Included in a sync run before any provider request, and never recomputed for
 * that run — the snapshot is what the run used even if the mapping changes
 * while it is still paging.
 */

import { createHash } from "node:crypto";

import type { FieldMappingRule } from "../types/mapping";

/**
 * Bump when the meaning of a rule changes, not when its shape does.
 *
 * The content hash alone covers edits to an integration's rules. It cannot see
 * a deploy that changes what a transform or target means, so this number is
 * folded into the digest: incrementing it makes every newly recorded version
 * distinct from every older one.
 */
export const MAPPING_RULE_VERSION = 1;

/**
 * Code-unit ordering, not `localeCompare`.
 *
 * The hash has to be identical on every machine and Node build. Locale-aware
 * collation can change with ICU data, which would silently give the same rules
 * a different version after an upgrade.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `v<rule version>-<sha256>`; full digest, shortened only for display. */
export function mappingVersionFor(
  rules: readonly FieldMappingRule[]
): string {
  const canonical = rules
    .map((rule) => ({
      sourceFieldPath: rule.sourceFieldPath,
      targetObject: rule.targetObject,
      targetFieldPath: rule.targetFieldPath,
      transform: rule.transform,
    }))
    .sort(
      (a, b) =>
        compareText(a.targetObject, b.targetObject) ||
        compareText(a.targetFieldPath, b.targetFieldPath) ||
        compareText(a.sourceFieldPath, b.sourceFieldPath) ||
        compareText(a.transform, b.transform)
    );

  const digest = createHash("sha256")
    .update(
      JSON.stringify({ version: MAPPING_RULE_VERSION, rules: canonical })
    )
    .digest("hex");

  return `v${MAPPING_RULE_VERSION}-${digest}`;
}
