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
 * Three changes are carried here:
 *
 *   1. **The account email became a column.** Stripe's `email` and Metrifox's
 *      `primary_email` used to land in `customFields`; they now target the
 *      first-class `customer.email` that identity resolution matches on.
 *   2. **Metrifox gained `crossRef.stripe`.** The `payments_stripe_customers`
 *      join is on by default for new connections and unreachable for old ones.
 *   3. **HubSpot deals stopped inventing status and dates.** The old defaults
 *      synthesized `agreement_status`, `effective_date` and `end_date` from
 *      closed flags and CRM timestamps. Those rules are removed, and the values
 *      they already wrote are cleared — a provider fact was never behind them.
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

/**
 * Defaults that were removed because the source field no longer exists.
 *
 * A rule naming a source the handler stopped synthesizing would otherwise keep
 * writing null, erasing the stored field on the next sync. Removing the rule is
 * the mapping half; clearing the value it already wrote is the data half, and
 * both are needed for the field to stop claiming something the provider never
 * said.
 */
const RETIRED_RULES: Readonly<
  Record<
    string,
    Readonly<
      Record<
        string,
        ReadonlyArray<{
          sourceFieldPath: string;
          targetObject: FieldMappingRule["targetObject"];
          targetFieldPath: string;
          reason: string;
        }>
      >
    >
  >
> = {
  hubspot: {
    agreement: [
      {
        sourceFieldPath: "agreement_status",
        targetObject: "agreement",
        targetFieldPath: "status",
        reason:
          "HubSpot deal stage and closed flags are not our agreement status",
      },
      {
        sourceFieldPath: "effective_date",
        targetObject: "agreement",
        targetFieldPath: "effectiveDate",
        reason:
          "HubSpot's create date is not an agreement effective date",
      },
      {
        sourceFieldPath: "end_date",
        targetObject: "agreement",
        targetFieldPath: "endDate",
        reason: "HubSpot's close date is not an agreement end date",
      },
    ],
  },
};

export interface RetiredMappingMatch {
  rule: StoredMappingRule;
  reason: string;
}

/**
 * Find stored rules whose synthesized source was retired.
 *
 * Matching is by **source**, not target, so a user who sent the old synthesized
 * status to a custom field is caught too. That rule would now read a field the
 * handler no longer emits and write null on every sync. What is deliberately
 * not matched is the raw provider source: `properties.createdate` is still
 * there, so a mapping from it to `effectiveDate` remains valid.
 */
export function findRetiredRules(
  providerName: string,
  functionName: string,
  rules: readonly StoredMappingRule[]
): RetiredMappingMatch[] {
  const retired = RETIRED_RULES[providerName]?.[functionName] ?? [];
  const matches: RetiredMappingMatch[] = [];

  for (const rule of rules) {
    const definition = retired.find(
      (candidate) =>
        candidate.sourceFieldPath === rule.sourceFieldPath &&
        candidate.targetObject === rule.targetObject
    );
    if (definition !== undefined) {
      matches.push({ rule, reason: definition.reason });
    }
  }

  return matches.sort((a, b) =>
    a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0
  );
}

export interface RetiredField {
  targetObject: FieldMappingRule["targetObject"];
  targetFieldPath: string;
  reason: string;
}

export interface MappingRetargetPlan {
  /** Rows to update in place, keeping their id, source path and transform. */
  retarget: Array<{ id: string; from: string; to: string }>;
  /** Rows to delete, each with the reason to print beside it. */
  remove: Array<{ id: string; targetFieldPath: string; reason: string }>;
  /** Rules with no existing row, to insert. */
  add: FieldMappingRule[];
  /**
   * Stored record fields a removed rule used to fill.
   *
   * The rule change fixes the next sync; this is what lets the migration clear
   * values that were already written from the retired source. A rule removed
   * without its value cleared would leave an inferred fact behind with nothing
   * left to correct it.
   */
  clearFields: RetiredField[];
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
  const clearFields: RetiredField[] = [];

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

  // --- rules whose synthesized source was retired ---------------------------

  for (const match of findRetiredRules(providerName, functionName, rules)) {
    remove.push({
      id: match.rule.id,
      targetFieldPath: match.rule.targetFieldPath,
      reason: match.reason,
    });
    // Only the lifecycle columns this build knows how to clear. A rule that
    // sent the retired source to a custom field is removed too, but its JSON
    // value is left alone rather than guessed at.
    if (
      match.rule.targetFieldPath === "status" ||
      match.rule.targetFieldPath === "effectiveDate" ||
      match.rule.targetFieldPath === "endDate"
    ) {
      clearFields.push({
        targetObject:
          match.rule.targetObject as FieldMappingRule["targetObject"],
        targetFieldPath: match.rule.targetFieldPath,
        reason: match.reason,
      });
    }
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
    clearFields,
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
