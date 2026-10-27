/**
 * The provider account behind a credential, as a stored value rather than a
 * string recomputed from token metadata at match time.
 *
 * Two integrations of the same tenant-scoped provider are not interchangeable:
 * HubSpot company `12345` in one portal is a different business from `12345` in
 * another. The account id is what makes that distinction addressable. It also
 * gives a credential change something to compare: if an integration is re-keyed
 * to a different account, the keys emitted under the old one must not keep
 * matching.
 */

import { prisma } from "@/lib/prisma";
import {
  externalIdScopeValue,
  providerRegistry,
} from "../registries/provider-registry";
import type { ProviderMetadata } from "../types/registry";

/**
 * Read the source account out of credential metadata.
 *
 * `""` is a real, known value: the provider's ids are global, so the scope is
 * deliberately empty. `null` means the credential does not name its account,
 * which is the fail-closed state for a tenant-scoped provider — no self-key is
 * emitted rather than an unscoped one.
 */
export function sourceAccountIdFromMetadata(
  providerName: string,
  metadata: ProviderMetadata
): string | null {
  const provider = providerRegistry.get(providerName);
  if (provider === undefined) return null;

  return externalIdScopeValue(provider, metadata) ?? null;
}

export interface SourceAccountChange {
  previous: string | null;
  current: string | null;
  /** The stored account value changed, even if no keys needed retiring. */
  changed: boolean;
  /** Old keys deleted because the credential now names a different account. */
  retiredKeys: number;
}

/**
 * Record the account a credential points at, retiring old keys on a re-key.
 *
 * Called after a credential is stored, never on a timer. `null` is a no-op:
 * a credential that does not name its account cannot prove the old one is
 * wrong, and clearing the stored value would only make every later transition
 * harder to detect.
 *
 * On a change, **all** keys sourced from this integration are deleted, not only
 * those whose stored `sourceAccountId` matches the old value. Keys written
 * before the account was first recorded have no account snapshot, and a key
 * from the old account is exactly the thing that must not survive. The next
 * resolution pass rebuilds the current account's keys; until then a join is
 * missing, which is the safe direction.
 */
export async function recordSourceAccount(args: {
  integrationId: string;
  sourceAccountId: string | null;
}): Promise<SourceAccountChange> {
  if (args.sourceAccountId === null) {
    const current = await prisma.integration.findUnique({
      where: { id: args.integrationId },
      select: { sourceAccountId: true },
    });
    return {
      previous: current?.sourceAccountId ?? null,
      current: current?.sourceAccountId ?? null,
      changed: false,
      retiredKeys: 0,
    };
  }

  return prisma.$transaction(async (tx) => {
    const integration = await tx.integration.findUnique({
      where: { id: args.integrationId },
      select: { sourceAccountId: true },
    });
    if (integration === null) {
      return {
        previous: null,
        current: null,
        changed: false,
        retiredKeys: 0,
      };
    }

    // Keys are the fallback record of the account for integrations connected
    // before this column existed. If they name a different account, or more
    // than one, the credential has moved and none of those claims can stand.
    const scopedKeys =
      integration.sourceAccountId === null
        ? await tx.customerAccountKey.findMany({
            where: {
              sourceIntegrationId: args.integrationId,
              sourceAccountId: { not: null },
            },
            select: { sourceAccountId: true },
            distinct: ["sourceAccountId"],
            orderBy: { sourceAccountId: "asc" },
          })
        : [];
    const legacyKeyCount =
      integration.sourceAccountId === null
        ? await tx.customerAccountKey.count({
            where: {
              sourceIntegrationId: args.integrationId,
              sourceAccountId: null,
            },
          })
        : 0;

    const previous =
      integration.sourceAccountId ?? scopedKeys[0]?.sourceAccountId ?? null;
    const changed = previous !== args.sourceAccountId;
    // With no stored account, a key with no snapshot cannot be proven to
    // belong to the account being recorded. Retire it along with any scoped
    // key that names a different one; a missing join is recoverable, a stale
    // claim across accounts is not.
    const staleKeys =
      integration.sourceAccountId !== null
        ? changed
        : legacyKeyCount > 0 ||
          scopedKeys.some(
            (row) => row.sourceAccountId !== args.sourceAccountId
          );

    let retiredKeys = 0;
    if (staleKeys) {
      const deleted = await tx.customerAccountKey.deleteMany({
        where: { sourceIntegrationId: args.integrationId },
      });
      retiredKeys = deleted.count;
    }

    if (changed) {
      await tx.integration.update({
        where: { id: args.integrationId },
        data: { sourceAccountId: args.sourceAccountId },
      });
    }

    return {
      previous,
      current: args.sourceAccountId,
      changed,
      retiredKeys,
    };
  });
}
