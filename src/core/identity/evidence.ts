/**
 * Turning one customer row into the keys it can be matched on.
 *
 * Pure — no database, no clock. It reads the registry, which is a lookup over
 * static definitions once `bootstrap()` has run, for the same reason
 * `identity-schema.ts` does: whether a provider's ids are globally unique is a
 * property of the provider, and duplicating that answer here would let the two
 * drift.
 *
 * ## Every emission is fail-closed
 *
 * A key that cannot be built correctly is not built. There is no "best effort"
 * branch anywhere below, because the cost of the two outcomes is not
 * symmetrical: a missing key costs a join the user can make by hand, while a
 * wrong key silently merges two companies — possibly two *tenants'* companies —
 * and looks exactly like the matcher working well.
 */

import { externalIdScopeValue, providerRegistry } from "../registries/provider-registry";
import type {
  NewIdentityKey,
  ResolutionCustomer,
} from "../repositories/identity-repository";
import { externalRefValue, normalizeDomain, normalizeEmail } from "./normalize";

/**
 * `customFields` keys that held an account email before it became a column.
 *
 * Stage 1 retargeted the Stripe and Metrifox defaults to `customer.email`, but
 * `seedMappingsIfEmpty` bails when an integration already has any mapping, so
 * connections made before that change still write here.
 *
 * **To remove this**, run `npm run mappings:retarget -- --apply` against every
 * deployment first. That script rewrites the mappings *and* moves the addresses
 * already synced into the column, which is the part that matters: dropping
 * these two keys while a record still carries its address only in
 * `customFields` does not merely stop a new join, it silently *unmakes* one
 * that already exists, and the account it was holding together comes apart on
 * the next pass with nothing in the run's issues to explain why.
 *
 * The script names every record it could not move — a malformed address, or a
 * column already holding a different one — and that list is the set of joins
 * this removal would cost. An empty list is the go-ahead.
 */
const LEGACY_EMAIL_CUSTOM_FIELDS = ["email", "primary_email"] as const;

/**
 * The scope segment to use for each provider's ids when a *foreign* record
 * names one.
 *
 * Distinct from the self-key's scope, and weaker on purpose. A self-key knows
 * exactly which connection it came from, so it can always use that
 * integration's own metadata. A cross-reference says only "this company is
 * `12345` in HubSpot" — if the user has two HubSpot portals connected, that
 * sentence does not identify a company, and guessing a portal would produce the
 * precise false merge the scope segment exists to prevent.
 *
 * So a provider appears here only when its scope is unambiguous: globally
 * unique ids, or exactly one connected integration with a usable scope value.
 */
export type ForeignScopes = ReadonlyMap<string, string>;

/**
 * The account scope for a customer's own connection.
 *
 * Prefers the stored, addressable value. Token metadata remains a fallback for
 * connections made before `Integration.sourceAccountId` existed; it is not the
 * authority, because it is overwritten on a re-key while the keys emitted under
 * the old account are still in the database.
 *
 * An empty string is a real answer — the provider's ids are global. Undefined
 * means a tenant-scoped connection whose account is unknown, which must not
 * emit a self-key.
 */
function scopeForCustomer(
  customer: ResolutionCustomer
): string | undefined {
  const definition = providerRegistry.get(customer.providerName);
  if (definition === undefined) return undefined;
  if (customer.sourceAccountId !== null) return customer.sourceAccountId;
  return externalIdScopeValue(definition, customer.providerMetadata);
}

/**
 * Work out which providers a cross-reference can safely name.
 *
 * @param customers Every customer in the tenant — the integrations they belong
 *   to are the complete set of connections a cross-reference could mean.
 */
export function buildForeignScopes(
  customers: readonly ResolutionCustomer[]
): ForeignScopes {
  // providerName -> integrationId -> scope value. Keyed by integration so two
  // customers from the same connection count once.
  const byProvider = new Map<string, Map<string, string>>();

  for (const customer of customers) {
    const scope = scopeForCustomer(customer);
    if (scope === undefined) continue;

    const seen = byProvider.get(customer.providerName) ?? new Map<string, string>();
    seen.set(customer.integrationId, scope);
    byProvider.set(customer.providerName, seen);
  }

  const resolved = new Map<string, string>();
  for (const [providerName, scopesByIntegration] of byProvider) {
    const distinct = new Set(scopesByIntegration.values());
    // One scope value across every connection of this provider. For a global
    // provider that is `""` however many integrations exist, which is the whole
    // point of calling it global.
    if (distinct.size === 1) {
      resolved.set(providerName, [...distinct][0]!);
    }
  }

  return resolved;
}

/**
 * Every match key one customer contributes, strongest kind first.
 *
 * De-duplicated on `(kind, value)` with the first occurrence winning, so the
 * key keeps the label of the strongest source that produced it. That is also
 * why Stripe's synthesized contact needs no special case: `synthesizeContact`
 * copies the customer's own address onto a contact, so it arrives here as a
 * duplicate of the `customer_email` key and falls out of the dedupe on its own.
 * A branch naming Stripe would be a branch that does nothing.
 */
export function buildEvidence(
  customer: ResolutionCustomer,
  foreignScopes: ForeignScopes
): NewIdentityKey[] {
  const keys: NewIdentityKey[] = [];
  const seen = new Set<string>();
  const sourceAccountId = scopeForCustomer(customer) ?? null;

  const push = (key: NewIdentityKey): void => {
    const dedupe = `${key.kind} ${key.value}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    keys.push(key);
  };

  const pushEmail = (
    raw: string | null,
    source: NewIdentityKey["source"],
    sourceRecordId: string
  ): void => {
    const normalized = normalizeEmail(raw);
    if (normalized === undefined) return;
    push({
      kind: "email",
      value: normalized.value,
      // The address as the provider wrote it, so a user adjudicating a conflict
      // sees what they recognise rather than the plus-tag-stripped form.
      rawValue: raw ?? normalized.value,
      emailClass: normalized.emailClass,
      source,
      sourceIntegrationId: customer.integrationId,
      sourceAccountId,
      sourceRecordId,
    });
  };

  // --- external_ref: hard ids, the strongest kind -------------------------

  // This record's own id, free of charge. It is what makes a crosswalk usable
  // at all: only the *other* side has to name an id, because Stripe has no idea
  // what its Metrifox id is.
  //
  // `undefined` means a tenant-scoped provider whose account we cannot name.
  // It emits no self-key, which is correct rather than broken:
  // `hubspot::12345` would merge company 12345 in one portal with a different
  // company 12345 in another.
  if (sourceAccountId !== null) {
    const value = externalRefValue({
      providerName: customer.providerName,
      scope: sourceAccountId,
      externalId: customer.externalSourceId,
    });
    if (value !== undefined) {
      push({
        kind: "external_ref",
        value,
        rawValue: customer.externalSourceId,
        // Not an address. Stored uniformly so the column is never null and a
        // reader never has to ask which kinds classify.
        emailClass: "corporate",
        source: "self_reference",
        sourceIntegrationId: customer.integrationId,
        sourceAccountId,
        sourceRecordId: customer.externalSourceId,
      });
    }
  }

  // Ids this record claims for the same company in another system. Mapped
  // rules first, then human-imported pairs, each sorted so the emission order
  // is a function of the data rather than of JSON key order.
  //
  // A mapped rule outranking an imported pair looks backwards — a human should
  // beat a mapping — but nothing is actually being overruled. The two only meet
  // when they name the *same* provider, and the dedupe is on `(kind, value)`:
  // agreeing pairs collapse to one key either way, and disagreeing ones each
  // emit their own key, so both joins are attempted. All the order decides is
  // which source label a shared key carries, and `mapped_cross_ref` is the more
  // specific claim of the two — it names the field the id was read from.
  const foreignIds: ReadonlyArray<
    readonly [string, string, NewIdentityKey["source"]]
  > = [
    ...sortedEntries(customer.crossRefs).map(
      ([provider, id]) => [provider, id, "mapped_cross_ref"] as const
    ),
    ...sortedEntries(customer.importedCrossRefs).map(
      ([provider, id]) => [provider, id, "imported_crosswalk"] as const
    ),
  ];

  for (const [providerName, foreignId, source] of foreignIds) {
    const scope = foreignScopes.get(providerName);
    if (scope === undefined) continue;

    const value = externalRefValue({ providerName, scope, externalId: foreignId });
    if (value === undefined) continue;

    push({
      kind: "external_ref",
      value,
      rawValue: foreignId,
      emailClass: "corporate",
      source,
      sourceIntegrationId: customer.integrationId,
      sourceAccountId,
      sourceRecordId: customer.externalSourceId,
    });
  }

  // --- email --------------------------------------------------------------

  pushEmail(customer.email, "customer_email", customer.externalSourceId);

  for (const legacyKey of LEGACY_EMAIL_CUSTOM_FIELDS) {
    pushEmail(
      customer.customFields[legacyKey] ?? null,
      "customer_custom_field",
      customer.externalSourceId
    );
  }

  // Contacts are the universal source: all five providers map `contact.email`,
  // while only two carry an account-level address. Sorted by the repository, and
  // only contacts whose company resolved to *this* customer are reachable here —
  // a contact with no company is not evidence about any company.
  //
  // A freemail contact address still matches, per the classification rule: the
  // class stops a consumer host becoming a *domain* key, it does not filter the
  // address. The residual risk is a contractor whose personal address appears
  // under two firms; `distinct` is the remedy, and it is why domain ranks below
  // email rather than why either is dropped.
  for (const contact of customer.contactEmails) {
    pushEmail(contact.email, "contact_email", contact.externalSourceId);
  }

  // --- domain: weakest, and only ever from the mapped column ---------------

  // Never from an email host. A user can map `email --domainFromUrl--> domain`
  // in one click, and `normalizeDomain`'s blocklist catches `gmail.com` but not
  // a small regional ISP — so the restriction is structural here rather than a
  // matter of remembering to check.
  const domain = normalizeDomain(customer.domain);
  if (domain !== undefined) {
    push({
      kind: "domain",
      value: domain,
      rawValue: customer.domain ?? domain,
      // A blocklisted host never became a domain key at all, so anything that
      // reaches this point is by definition a company domain.
      emailClass: "corporate",
      source: "customer_domain",
      sourceIntegrationId: customer.integrationId,
      sourceAccountId,
      sourceRecordId: customer.externalSourceId,
    });
  }

  return keys;
}

/** Entries of a JSON-column object, ordered by key so emission is reproducible. */
function sortedEntries(source: Record<string, string>): Array<[string, string]> {
  return Object.entries(source).sort((a, b) => a[0].localeCompare(b[0]));
}
