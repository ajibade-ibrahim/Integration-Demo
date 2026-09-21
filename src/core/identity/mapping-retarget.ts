/**
 * Moving already-connected integrations onto a default that changed.
 *
 * `seedMappingsIfEmpty` returns early when an integration has any mapping at
 * all (`mapping-repository.ts:84`), which is the right behaviour — it is what
 * stops a reconnect from trampling a user's edits. The cost is that a
 * connection made before a default changed never picks the change up, and no
 * amount of editing `defaults.ts` will reach it. So a default that changes
 * after the fact needs a migration, and this module is the decision half of
 * one; `scripts/retarget-account-email-mappings.mts` is the I/O half.
 *
 * Two changes are carried here, both from the identity work:
 *
 *   1. **The account email became a column.** Stripe's `email` and Metrifox's
 *      `primary_email` used to land in `customFields`; they now target the
 *      first-class `customer.email` that identity resolution matches on.
 *   2. **Metrifox gained `crossRef.stripe`.** The `payments_stripe_customers`
 *      join is on by default for new connections and unreachable for old ones.
 *
 * ## Why this is a rewrite and not an addition
 *
 * `validateMappings` is perfectly happy with `customFields.email` and `email`
 * mapped side by side — they are different target paths, so the duplicate check
 * never fires. The result is the same address written to two places on every
 * record of every sync, and two keys offered to the resolver that dedupe to
 * one. Nothing breaks loudly; it just quietly double-stores forever. So the
 * legacy rule is retargeted in place or deleted, never left beside a new one.
 *
 * ## Why the transform is preserved
 *
 * The current defaults use `lowercase`, and an older rule may say `trim` or
 * `none`. Rewriting it to match would be a second, unannounced change to
 * behaviour the user may have chosen: the mandate here is the target path.
 * Nothing depends on the stored case anyway — `normalizeEmail` lowercases
 * before matching, so the join is unaffected either way.
 */

import { IDENTITY_SCHEMA } from "../identity-schema";
import type { FieldMappingRule, FieldTransform } from "../types/mapping";
import { EMAIL_PATTERN } from "./normalize";

/**
 * The `customFields` targets that held an account email before it was a column,
 * in the order a tie is broken. Mirrors `LEGACY_EMAIL_CUSTOM_FIELDS` in
 * `evidence.ts`, which reads the same two keys — that fallback is what keeps
 * un-migrated connections resolving, and it can only be dropped once this has
 * run everywhere.
 */
export const LEGACY_EMAIL_TARGETS = [
  "customFields.email",
  "customFields.primary_email",
] as const;

/** The first-class field they move to. */
export const ACCOUNT_EMAIL_TARGET = "email";

/**
 * Rules added to a provider's defaults *after* connections already existed, and
 * therefore reachable only by migration.
 *
 * A table rather than an `if`, because this is a recurring shape rather than a
 * one-off: every future default added to a shipped provider lands here, and a
 * list is the only place a reader can see which ones are outstanding.
 *
 * Adding one costs nothing where the provider does not serve the source field —
 * `applyMappings` emits no value for a source path that is absent, so a tenant
 * whose Metrifox API carries no `stripe_customer_id` is unaffected.
 */
export const LATE_DEFAULTS: Readonly<
  Record<string, Readonly<Record<string, readonly FieldMappingRule[]>>>
> = {
  metrifox: {
    identity: [
      {
        sourceFieldPath: "stripe_customer_id",
        targetObject: "customer",
        targetFieldPath: "crossRef.stripe",
        transform: "trim",
      },
    ],
  },
};

/** One `FieldMapping` row, as much of it as a decision needs. */
export interface StoredMappingRule {
  id: string;
  targetObject: string;
  sourceFieldPath: string;
  targetFieldPath: string;
  transform: string;
}

export interface MappingRetargetPlan {
  /** Rows to update in place, keeping their id, source path and transform. */
  retarget: Array<{ id: string; from: string; to: string }>;
  /** Rows to delete, each with the reason to print beside it. */
  remove: Array<{ id: string; targetFieldPath: string; reason: string }>;
  /** Rules with no existing row, to insert. */
  add: FieldMappingRule[];
  /**
   * The rule set as it will be once the plan is applied.
   *
   * Handed to `validateMappings` before anything is written. The plan should
   * never produce an invalid set, which is exactly why it is worth checking:
   * the failure this guards against is a *silent* one, and the alternative to
   * catching it here is finding it when a user's next sync stops writing.
   */
  result: FieldMappingRule[];
  /** True when there is nothing to do, so the caller can stay quiet. */
  empty: boolean;
}

/**
 * Work out what one integration's rule set for one function should become.
 *
 * Pure, and deterministic down to the ordering: two legacy rules on the same
 * integration are resolved by `LEGACY_EMAIL_TARGETS` order and then by id, so a
 * dry run and the apply that follows it make the same choice.
 */
export function planMappingRetarget(args: {
  providerName: string;
  functionName: string;
  rules: readonly StoredMappingRule[];
}): MappingRetargetPlan {
  const { providerName, functionName, rules } = args;

  const retarget: MappingRetargetPlan["retarget"] = [];
  const remove: MappingRetargetPlan["remove"] = [];
  const add: FieldMappingRule[] = [];

  // --- the account email ----------------------------------------------------

  const legacyOrder = (path: string): number =>
    (LEGACY_EMAIL_TARGETS as readonly string[]).indexOf(path);

  const legacy = rules
    .filter(
      (rule) =>
        rule.targetObject === "customer" && legacyOrder(rule.targetFieldPath) >= 0
    )
    .sort(
      (a, b) =>
        legacyOrder(a.targetFieldPath) - legacyOrder(b.targetFieldPath) ||
        a.id.localeCompare(b.id)
    );

  const alreadyTargeted = rules.find(
    (rule) =>
      rule.targetObject === "customer" &&
      rule.targetFieldPath === ACCOUNT_EMAIL_TARGET
  );

  // A half-migrated integration is a real case, not an odd one: a user may have
  // added the mapping by hand after reading the release note. Delete the legacy
  // rule rather than touching theirs — the address is already reaching the
  // column, and their source field is the one they chose.
  const keep = alreadyTargeted === undefined ? legacy[0] : undefined;

  if (keep !== undefined) {
    retarget.push({
      id: keep.id,
      from: keep.targetFieldPath,
      to: ACCOUNT_EMAIL_TARGET,
    });
  }

  for (const rule of legacy) {
    if (rule.id === keep?.id) continue;
    remove.push({
      id: rule.id,
      targetFieldPath: rule.targetFieldPath,
      reason:
        alreadyTargeted !== undefined
          ? `customer.email is already mapped from '${alreadyTargeted.sourceFieldPath}'`
          : `customer.email can only be mapped once; keeping '${keep?.sourceFieldPath ?? ""}'`,
    });
  }

  // --- defaults this connection is too old to have --------------------------

  // Only for a function this integration actually maps. An empty rule set means
  // the function is not configured, and seeding one rule into it would produce
  // a config no default ever produced.
  if (rules.length > 0) {
    for (const rule of LATE_DEFAULTS[providerName]?.[functionName] ?? []) {
      const present = rules.some(
        (existing) =>
          existing.targetObject === rule.targetObject &&
          existing.targetFieldPath === rule.targetFieldPath
      );
      if (!present) add.push(rule);
    }
  }

  // --- the resulting set, for validation ------------------------------------

  const removed = new Set(remove.map((entry) => entry.id));
  const retargeted = new Map(retarget.map((entry) => [entry.id, entry.to]));

  const result: FieldMappingRule[] = rules
    .filter((rule) => !removed.has(rule.id))
    .map((rule) => ({
      sourceFieldPath: rule.sourceFieldPath,
      targetObject: rule.targetObject as FieldMappingRule["targetObject"],
      targetFieldPath: retargeted.get(rule.id) ?? rule.targetFieldPath,
      transform: rule.transform as FieldTransform,
    }))
    .concat(add);

  return {
    retarget,
    remove,
    add,
    result,
    empty: retarget.length === 0 && remove.length === 0 && add.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The rows the mappings already wrote
// ---------------------------------------------------------------------------

/**
 * Retargeting the rule fixes the *next* sync. This fixes the rows already
 * synced.
 *
 * Without it the migration appears to do nothing: every existing customer keeps
 * a null `email` column until its integration next runs, and a tenant that has
 * stopped syncing keeps it forever. It is also what makes the legacy
 * `customFields` fallback in `evidence.ts` removable — the address has to be in
 * the column before the code stops looking beside it.
 *
 * Nothing is destroyed. A key is only dropped from `customFields` once the same
 * address is in the column, so this moves a value rather than deleting one.
 */
export type EmailBackfill =
  | { kind: "skip"; reason: string }
  | { kind: "promote"; email: string; customFields: Record<string, string> }
  | { kind: "deduplicate"; customFields: Record<string, string> };

const MAX_EMAIL_LENGTH =
  IDENTITY_SCHEMA.customer.fields.find((field) => field.name === "email")
    ?.maxLength ?? 254;

export function planEmailBackfill(customer: {
  email: string | null;
  customFields: Record<string, string>;
}): EmailBackfill {
  const legacyKey = LEGACY_EMAIL_TARGETS.map((target) =>
    target.slice("customFields.".length)
  ).find((key) => (customer.customFields[key] ?? "").trim() !== "");

  if (legacyKey === undefined) return { kind: "skip", reason: "no legacy key" };

  const value = (customer.customFields[legacyKey] ?? "").trim();
  const without = { ...customer.customFields };
  delete without[legacyKey];

  if (
    customer.email !== null &&
    customer.email.toLowerCase() === value.toLowerCase()
  ) {
    return { kind: "deduplicate", customFields: without };
  }

  // Left alone rather than overwritten. A populated column means the retargeted
  // rule has already run at least once, so it holds the newer of the two — but
  // they disagree, and a migration is the wrong place to decide which address a
  // company uses.
  if (customer.email !== null) {
    return {
      kind: "skip",
      reason: `customer.email already holds a different address (${customer.email})`,
    };
  }

  // The same verdict `record-writer` reaches on a bad account email: warn and
  // leave the column unset. Agreeing with it matters — a value this refuses and
  // the writer accepts, or the reverse, would flip on the next sync.
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
    return {
      kind: "skip",
      reason: `'${value}' is not a valid email address; left in customFields`,
    };
  }

  return { kind: "promote", email: value, customFields: without };
}
