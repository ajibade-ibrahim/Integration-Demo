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

import { IDENTITY_SCHEMA, type FieldDefinition } from "../identity-schema";
import { MAX_CUSTOM_FIELDS } from "../identity-schema";
import type { AccountFields, ResolutionCustomer } from "../repositories/identity-repository";
import type { CustomerType, IdentityIssue } from "../types/common";

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

interface FieldOutcome {
  value: string | Date | undefined;
  /** The integration whose value won, for provenance. */
  integrationId: string | undefined;
  issue: IdentityIssue | undefined;
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
  const supplied = ranked.flatMap((member) => {
    const value = memberValue(member, field.name);
    return value === undefined || value === null ? [] : [{ member, value }];
  });

  if (supplied.length === 0) {
    return { value: undefined, integrationId: undefined, issue: undefined };
  }

  if (field.conflictPolicy === "earliest") {
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
      integrationId: winner.member.integrationId,
      issue: undefined,
    };
  }

  const winner = supplied[0]!;
  const tied = supplied.filter(
    (candidate) =>
      candidate.member.identityPriority === winner.member.identityPriority &&
      comparable(candidate.value) !== comparable(winner.value)
  );

  if (tied.length === 0) {
    return {
      value: winner.value,
      integrationId: winner.member.integrationId,
      issue: undefined,
    };
  }

  // The winner is included so the UI can show what was chosen alongside what
  // was rejected; index-aligned with `integrationIds`.
  const contenders = [winner, ...tied];
  return {
    value: winner.value,
    integrationId: winner.member.integrationId,
    issue: {
      kind: "field_conflict",
      reason: `${contenders.length} equally ranked sources disagree on ${field.label.toLowerCase()}`,
      accountId,
      fieldName: field.name,
      values: contenders.map((c) => comparable(c.value)),
      integrationIds: contenders.map((c) => c.member.integrationId),
    },
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
  ranked: readonly ResolutionCustomer[]
): Record<string, string> {
  const merged = new Map<string, string>();
  for (const member of ranked) {
    for (const [key, value] of Object.entries(member.customFields)) {
      if (value === "" || merged.has(key)) continue;
      merged.set(key, value);
    }
  }

  return Object.fromEntries(
    [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, MAX_CUSTOM_FIELDS)
  );
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
  const fieldProvenance: Record<string, string> = {};

  const resolved = new Map<string, string | Date | undefined>();
  for (const field of IDENTITY_SCHEMA.customer.fields) {
    const outcome = resolveField(accountId, ranked, field);
    resolved.set(field.name, outcome.value);
    if (outcome.integrationId !== undefined) {
      fieldProvenance[field.name] = outcome.integrationId;
    }
    if (outcome.issue !== undefined) issues.push(outcome.issue);
  }

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
      customFields: resolveCustomFields(ranked),
      fieldProvenance,
    },
    issues,
  };
}
