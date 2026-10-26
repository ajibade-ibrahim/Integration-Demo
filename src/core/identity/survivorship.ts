/**
 * Deciding what an account *says about itself* once several systems describe it.
 *
 * Pure. No database, no registry, no clock — the whole module is a function of
 * (members, their integrations' priorities), which is what lets the resolver
 * recompute every account's fields from scratch on every pass without risking
 * drift.
 *
 * ## The one rule worth remembering: a null is not an opinion
 *
 * The tempting implementation is "sort the members and take the winner's row".
 * It is wrong here, and the provider coverage is why: Stripe carries no
 * `industry`, `domain` or `type` at all; Metrifox carries no `industry`;
 * neither CRM carries an account-level `email`. Under row-wholesale
 * survivorship, ranking Stripe first would blank industry, domain and type on
 * every account Stripe touches — the user would rank a source *up* and watch
 * their data disappear.
 *
 * So each field is contested only among the members that actually supply it.
 * The hierarchy then composes: Stripe wins `email`, HubSpot wins `industry`,
 * and neither erases the other.
 *
 * ## What this module deliberately cannot do
 *
 * It never decides *membership*. Nothing here can move a customer between
 * accounts, and it is not given the means to: `resolveAccountFields` receives
 * the members it is told about and returns values. That separation is the
 * safety property the whole design rests on — changing `identityPriority`
 * changes what an account reports, never who is in it. If precedence could
 * repartition, editing a rank would silently regroup a user's customer list.
 */

import { IDENTITY_SCHEMA } from "../identity-schema";
import {
  MAX_CUSTOM_FIELDS,
  type FieldConflictPolicy,
  type FieldDefinition,
} from "../object-schema";
import type { AccountFields, ResolutionCustomer } from "../repositories/identity-repository";
import type {
  CustomerType,
  FieldAlternative,
  FieldConflictContender,
  FieldProvenanceEntry,
  FieldSourceEvidence,
  IdentityIssue,
} from "../types/common";

/**
 * Order members strongest-first for value conflicts.
 *
 * `(identityPriority, providerName, instanceLabel, id)`. The chain ends in a
 * unique id, so there is never an unbroken tie and the result cannot depend on
 * the order rows arrived in — but a tie *on priority alone* is still detected
 * and reported, because being deterministic is not the same as being right. See
 * `field_conflict` below.
 */
export function rankMembers(
  members: readonly ResolutionCustomer[]
): ResolutionCustomer[] {
  return [...members].sort(
    (a, b) =>
      a.identityPriority - b.identityPriority ||
      a.providerName.localeCompare(b.providerName) ||
      a.instanceLabel.localeCompare(b.instanceLabel) ||
      a.id.localeCompare(b.id)
  );
}

/**
 * The value one member supplies for one schema field, or `undefined` if it
 * supplies none.
 *
 * An empty string counts as no value. A provider that sends `""` for a field it
 * does not populate is not expressing an opinion either, and treating it as one
 * would let a blank from a high-ranked source beat a real value from a lower
 * one — the same destruction the null rule exists to prevent.
 */
function memberValue(
  member: ResolutionCustomer,
  fieldName: string
): string | Date | null | undefined {
  switch (fieldName) {
    case "name":
      return member.name.trim() === "" ? undefined : member.name;
    case "domain":
      return member.domain === null || member.domain.trim() === ""
        ? undefined
        : member.domain;
    case "email":
      return member.email === null || member.email.trim() === ""
        ? undefined
        : member.email;
    case "industry":
      return member.industry === null || member.industry.trim() === ""
        ? undefined
        : member.industry;
    case "createDate":
      return member.createDate ?? undefined;
    case "type":
      return member.type ?? undefined;
    default:
      return undefined;
  }
}

/** How a value is compared for the `field_conflict` check. */
function comparable(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface SuppliedField {
  member: ResolutionCustomer;
  value: string | Date;
}

interface FieldOutcome {
  value: string | Date | undefined;
  /** The source record and evidence behind the winning value. */
  provenance: FieldProvenanceEntry | undefined;
  issue: IdentityIssue | undefined;
}

interface CustomFieldsOutcome {
  values: Record<string, string>;
  provenance: Record<string, FieldProvenanceEntry>;
  issues: IdentityIssue[];
}

/** The source-record half of a provenance entry, before adding losing values. */
function evidenceFor(
  member: ResolutionCustomer,
  fieldPath: string,
  value: string | Date
): FieldSourceEvidence & { value: string } {
  const observed = comparable(value);
  return {
    integrationId: member.integrationId,
    providerName: member.providerName,
    instanceLabel: member.instanceLabel,
    customerId: member.id,
    externalSourceId: member.externalSourceId,
    evidenceKey: fieldPath,
    evidenceValue: observed,
    observedAt: member.observedAt.toISOString(),
    value: observed,
  };
}

function lostReason(
  candidate: SuppliedField,
  winner: SuppliedField,
  policy: FieldConflictPolicy
): string {
  if (policy === "earliest") {
    return `Later than ${winner.member.instanceLabel}'s ${comparable(
      winner.value
    )}; the earliest value wins`;
  }

  if (candidate.member.identityPriority !== winner.member.identityPriority) {
    return `Lower priority than ${winner.member.instanceLabel} (${candidate.member.identityPriority} vs ${winner.member.identityPriority})`;
  }

  const tieBreaker =
    candidate.member.providerName !== winner.member.providerName
      ? `provider name (${candidate.member.providerName} after ${winner.member.providerName})`
      : candidate.member.instanceLabel !== winner.member.instanceLabel
        ? `instance label (${candidate.member.instanceLabel} after ${winner.member.instanceLabel})`
        : "source record id";

  return `Equal priority with ${winner.member.instanceLabel}; tie broken by ${tieBreaker}`;
}

function winnerReason(policy: FieldConflictPolicy): string {
  return policy === "earliest"
    ? "Earliest value wins"
    : "Selected by the deterministic equal-priority tie-break";
}

function buildAlternatives(
  supplied: readonly SuppliedField[],
  winner: SuppliedField,
  fieldPath: string,
  policy: FieldConflictPolicy
): FieldAlternative[] {
  return supplied.flatMap((candidate) => {
    if (
      candidate === winner ||
      comparable(candidate.value) === comparable(winner.value)
    ) {
      return [];
    }

    return [
      {
        ...evidenceFor(candidate.member, fieldPath, candidate.value),
        reason: lostReason(candidate, winner, policy),
      },
    ];
  });
}

function buildProvenance(
  winner: SuppliedField,
  fieldPath: string,
  alternatives: readonly FieldAlternative[]
): FieldProvenanceEntry {
  return {
    ...evidenceFor(winner.member, fieldPath, winner.value),
    ...(alternatives.length === 0 ? {} : { alternatives: [...alternatives] }),
  };
}

function conflictIssue(args: {
  accountId: string;
  fieldName: string;
  fieldPath: string;
  label: string;
  winner: SuppliedField;
  tied: readonly SuppliedField[];
  policy: FieldConflictPolicy;
}): IdentityIssue {
  const { accountId, fieldName, fieldPath, label, winner, tied, policy } = args;

  const contenders: FieldConflictContender[] = [winner, ...tied].map(
    (candidate) => ({
      ...evidenceFor(candidate.member, fieldPath, candidate.value),
      won: candidate === winner,
      reason:
        candidate === winner
          ? winnerReason(policy)
          : lostReason(candidate, winner, policy),
    })
  );

  // The winner is included so the UI can show what was chosen alongside what
  // was rejected; index-aligned with `integrationIds`.
  return {
    kind: "field_conflict",
    reason: `${contenders.length} equally ranked sources disagree on ${label}`,
    accountId,
    fieldName,
    values: contenders.map((candidate) => candidate.value),
    integrationIds: contenders.map((candidate) => candidate.integrationId),
    contenders,
  };
}

/**
 * Resolve one field across the ranked members.
 *
 * Two policies, both declared on the field in `identity-schema.ts` rather than
 * branched on here by name:
 *
 * - `highestPriority` (default) — the first ranked member that supplies a value.
 * - `earliest` — the smallest value, currently only `createDate`. If HubSpot saw
 *   the company in 2019 and Stripe in 2023, it demonstrably existed in 2019, and
 *   letting rank decide would report a date we know to be wrong.
 *
 * A `field_conflict` issue is raised when two members at *equal priority* supply
 * different values. That is not a failure — the value returned is still
 * deterministic — it is the pass admitting the tiebreak was alphabetical rather
 * than meaningful, so the user finds out that their priorities have not actually
 * expressed a preference here. `earliest` fields raise none: there is nothing
 * for a human to prefer when the rule is "the oldest one".
 */
function resolveField(
  accountId: string,
  ranked: readonly ResolutionCustomer[],
  field: FieldDefinition
): FieldOutcome {
  const supplied: SuppliedField[] = ranked.flatMap((member) => {
    const value = memberValue(member, field.name);
    return value === undefined || value === null ? [] : [{ member, value }];
  });

  if (supplied.length === 0) {
    return { value: undefined, provenance: undefined, issue: undefined };
  }

  const policy = field.conflictPolicy ?? "highestPriority";

  if (policy === "earliest") {
    // Already in rank order, and `<` is strict, so an equal value keeps the
    // higher-ranked member's provenance.
    let winner = supplied[0]!;
    for (const candidate of supplied) {
      if (comparable(candidate.value) < comparable(winner.value)) {
        winner = candidate;
      }
    }
    return {
      value: winner.value,
      provenance: buildProvenance(
        winner,
        field.name,
        buildAlternatives(supplied, winner, field.name, policy)
      ),
      issue: undefined,
    };
  }

  const winner = supplied[0]!;
  const tied = supplied.filter(
    (candidate) =>
      candidate.member.identityPriority === winner.member.identityPriority &&
      comparable(candidate.value) !== comparable(winner.value)
  );

  return {
    value: winner.value,
    provenance: buildProvenance(
      winner,
      field.name,
      buildAlternatives(supplied, winner, field.name, policy)
    ),
    issue:
      tied.length === 0
        ? undefined
        : conflictIssue({
            accountId,
            fieldName: field.name,
            fieldPath: field.name,
            label: field.label.toLowerCase(),
            winner,
            tied,
            policy,
          }),
  };
}

/**
 * Union the members' custom fields, higher priority winning a shared key.
 *
 * Bounded by `MAX_CUSTOM_FIELDS` after sorting by key, so which fifty survive is
 * a property of the data rather than of member ordering. Truncation is silent:
 * custom fields are opaque extras, and an account that quietly carries the first
 * fifty is better than one that fails to resolve.
 */
function resolveCustomFields(
  accountId: string,
  ranked: readonly ResolutionCustomer[]
): CustomFieldsOutcome {
  // Rank order is preserved within each key, so the first source is the winner
  // under the same precedence rule as a regular field.
  const byKey = new Map<string, SuppliedField[]>();
  for (const member of ranked) {
    for (const [key, value] of Object.entries(member.customFields)) {
      if (value === "") continue;
      const supplied = byKey.get(key) ?? [];
      supplied.push({ member, value });
      byKey.set(key, supplied);
    }
  }

  const values: Record<string, string> = {};
  const provenance: Record<string, FieldProvenanceEntry> = {};
  const issues: IdentityIssue[] = [];

  const selectedKeys = [...byKey.keys()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_CUSTOM_FIELDS);

  for (const key of selectedKeys) {
    const supplied = byKey.get(key);
    if (supplied === undefined || supplied.length === 0) continue;

    const winner = supplied[0]!;
    const fieldPath = `customFields.${key}`;
    const alternatives = buildAlternatives(
      supplied,
      winner,
      fieldPath,
      "highestPriority"
    );

    values[key] = comparable(winner.value);
    provenance[fieldPath] = buildProvenance(winner, fieldPath, alternatives);

    const tied = supplied.filter(
      (candidate) =>
        candidate.member.identityPriority === winner.member.identityPriority &&
        comparable(candidate.value) !== comparable(winner.value)
    );
    if (tied.length > 0) {
      issues.push(
        conflictIssue({
          accountId,
          fieldName: fieldPath,
          fieldPath,
          label: `custom field "${key}"`,
          winner,
          tied,
          policy: "highestPriority",
        })
      );
    }
  }

  return { values, provenance, issues };
}

export interface SurvivorshipResult {
  fields: AccountFields;
  issues: IdentityIssue[];
}

/**
 * The golden record for one account.
 *
 * @param accountId Only used to stamp issues, so they are actionable without a
 *   second lookup. Nothing about the resolution depends on it.
 * @param members Every customer linked to the account. Must be non-empty — an
 *   account with no members has no fields to resolve and the pass reaps it
 *   instead of asking.
 */
export function resolveAccountFields(
  accountId: string,
  members: readonly ResolutionCustomer[]
): SurvivorshipResult {
  if (members.length === 0) {
    throw new Error("resolveAccountFields: an account with no members has no fields");
  }

  const ranked = rankMembers(members);
  const issues: IdentityIssue[] = [];
  const fieldProvenance: Record<string, FieldProvenanceEntry> = {};

  const resolved = new Map<string, string | Date | undefined>();
  for (const field of IDENTITY_SCHEMA.customer.fields) {
    const outcome = resolveField(accountId, ranked, field);
    resolved.set(field.name, outcome.value);
    if (outcome.provenance !== undefined) {
      fieldProvenance[field.name] = outcome.provenance;
    }
    if (outcome.issue !== undefined) issues.push(outcome.issue);
  }

  const custom = resolveCustomFields(accountId, ranked);
  issues.push(...custom.issues);

  const name = resolved.get("name");
  const domain = resolved.get("domain");
  const email = resolved.get("email");
  const industry = resolved.get("industry");
  const createDate = resolved.get("createDate");
  const type = resolved.get("type");

  return {
    fields: {
      // `name` is `required` in the schema, so the record writer rejected any
      // customer without one and at least one member must carry it. The
      // fallback is unreachable, and is here so a schema change that relaxes
      // `required` fails a test rather than writing `undefined` to a NOT NULL
      // column.
      name: typeof name === "string" ? name : (ranked[0]?.name ?? ""),
      domain: typeof domain === "string" ? domain : null,
      email: typeof email === "string" ? email : null,
      industry: typeof industry === "string" ? industry : null,
      createDate: createDate instanceof Date ? createDate : null,
      type: typeof type === "string" ? (type as CustomerType) : null,
      customFields: custom.values,
      fieldProvenance: { ...fieldProvenance, ...custom.provenance },
    },
    issues,
  };
}
