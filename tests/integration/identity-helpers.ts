/**
 * Building a tenant for the identity-resolution tests.
 *
 * Shared because all six of these files need the same awkward setup — several
 * connections of possibly the same provider, each with the token metadata a
 * tenant-scoped self-key depends on, and customers and contacts hung off them —
 * and because the readback shape is the assertion in most cases. A grouping is
 * only legible when it is expressed as sets of external ids; account uuids are
 * created fresh by every pass and comparing them across runs tells you nothing.
 *
 * Rows are written with Prisma directly rather than through the sync engine.
 * These tests are about the resolution pass, and driving five providers' HTTP
 * surfaces to arrive at "two customers share an email" would put the thing
 * under test behind a great deal of machinery that is tested elsewhere.
 */

import { randomUUID } from "node:crypto";

import {
  externalIdScopeValue,
  providerRegistry,
} from "@/core/registries/provider-registry";
import { deleteIntegration } from "@/core/repositories/integration-repository";
import { writeJsonObject } from "@/core/repositories/json-column";
import { parseFieldProvenance } from "@/core/identity/provenance";
import type { FieldProvenanceEntry } from "@/core/types/common";
import { prisma } from "@/lib/prisma";

/** One connected integration. */
export interface ConnectionSpec {
  /** A name in `providerRegistry` — the pass reads `externalIdScope` off it. */
  provider: string;
  /**
   * How the tests refer to this connection, defaulting to the provider name.
   * Needed only when one provider is connected twice, which is exactly the
   * case the scope segment exists for.
   */
  key?: string;
  identityPriority?: number;
  /**
   * Stored source account. Omit to derive it from `metadata`; pass explicitly
   * to model a connection whose stored account differs from stale metadata.
   */
  sourceAccountId?: string;
  /**
   * Token `providerMetadata`, which is where a tenant-scoped provider's scope
   * value lives. Omitting it is meaningful rather than lazy: a tenant-scoped
   * provider with no scope emits no self-key at all, and one test asserts it.
   */
  metadata?: Record<string, string>;
}

export interface CustomerSpec {
  name?: string;
  email?: string | null;
  domain?: string | null;
  industry?: string | null;
  createDate?: Date | null;
  type?: string | null;
  customFields?: Record<string, string>;
  crossRefs?: Record<string, string>;
}

export interface AccountView {
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  industry: string | null;
  fieldProvenance: Record<string, FieldProvenanceEntry>;
  /** Member external ids, sorted. */
  members: string[];
}

export async function makeIdentityTenant(connections: readonly ConnectionSpec[]) {
  const user = await prisma.user.create({
    data: { email: `identity-wiring-${randomUUID()}@test.local` },
    select: { id: true },
  });

  const ids = new Map<string, string>();

  function sourceAccountFor(spec: ConnectionSpec): string | null {
    if (spec.sourceAccountId !== undefined) return spec.sourceAccountId;
    if (spec.metadata === undefined) return null;

    const provider = providerRegistry.get(spec.provider);
    if (provider === undefined) return null;
    return externalIdScopeValue(provider, spec.metadata) ?? null;
  }

  for (const spec of connections) {
    const key = spec.key ?? spec.provider;
    const integration = await prisma.integration.create({
      data: {
        userId: user.id,
        providerName: spec.provider,
        status: "active",
        instanceLabel: `${spec.provider} — ${key}`,
        identityPriority: spec.identityPriority ?? 100,
        sourceAccountId: sourceAccountFor(spec),
        functions: { create: [{ functionName: "identity" }] },
        ...(spec.metadata === undefined
          ? {}
          : {
              token: {
                create: {
                  // Never read by the pass, which wants the metadata beside it
                  // rather than the credential. Junk rather than a real
                  // ciphertext, so nothing here can be mistaken for a working
                  // connection.
                  accessTokenEnc: "not-a-token",
                  expiresAt: new Date(Date.now() + 3_600_000),
                  providerMetadata: writeJsonObject(spec.metadata),
                },
              },
            }),
      },
      select: { id: true },
    });
    ids.set(key, integration.id);
  }

  function integrationId(key: string): string {
    const id = ids.get(key);
    if (id === undefined) throw new Error(`No connection keyed "${key}"`);
    return id;
  }

  /** @returns The new row id, which is what an assertion has to name. */
  async function customer(
    key: string,
    externalSourceId: string,
    spec: CustomerSpec = {}
  ): Promise<string> {
    const row = await prisma.customer.create({
      data: {
        integrationId: integrationId(key),
        externalSourceId,
        name: spec.name ?? externalSourceId,
        domain: spec.domain ?? null,
        email: spec.email ?? null,
        industry: spec.industry ?? null,
        createDate: spec.createDate ?? null,
        type: spec.type ?? null,
        customFields: writeJsonObject(spec.customFields ?? {}),
        crossRefs: writeJsonObject(spec.crossRefs ?? {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function contact(
    key: string,
    externalSourceId: string,
    spec: { email: string | null; customerId?: string }
  ): Promise<string> {
    const row = await prisma.contact.create({
      data: {
        integrationId: integrationId(key),
        externalSourceId,
        name: externalSourceId,
        email: spec.email,
        customerId: spec.customerId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Give a customer a value it did not arrive with, the way a re-sync would. */
  async function updateCustomer(
    customerId: string,
    spec: CustomerSpec
  ): Promise<void> {
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        ...(spec.email === undefined ? {} : { email: spec.email }),
        ...(spec.domain === undefined ? {} : { domain: spec.domain }),
        ...(spec.name === undefined ? {} : { name: spec.name }),
        ...(spec.crossRefs === undefined
          ? {}
          : { crossRefs: writeJsonObject(spec.crossRefs) }),
      },
    });
  }

  /**
   * Disconnect a provider the way the app does: customers cascade away and the
   * integration's own keys are retired, leaving the account shell for the reap.
   */
  async function deleteConnection(key: string): Promise<void> {
    await deleteIntegration(integrationId(key));
  }

  /**
   * The partition, as sorted sets of external ids.
   *
   * Content-keyed rather than account-keyed on purpose: two passes over the
   * same data produce different uuids for the same grouping, and it is the
   * grouping being asserted.
   */
  async function groups(): Promise<string[][]> {
    const customers = await prisma.customer.findMany({
      where: { integration: { userId: user.id } },
      select: { externalSourceId: true, customerAccountId: true },
    });

    const byAccount = new Map<string, string[]>();
    for (const row of customers) {
      const accountKey = row.customerAccountId ?? "UNLINKED";
      byAccount.set(accountKey, [
        ...(byAccount.get(accountKey) ?? []),
        row.externalSourceId,
      ]);
    }

    return [...byAccount.values()]
      .map((members) => members.sort())
      .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  }

  /** Every account in the tenant, with its members, sorted by first member. */
  async function accounts(): Promise<AccountView[]> {
    const rows = await prisma.customerAccount.findMany({
      where: { userId: user.id },
      include: { members: { select: { externalSourceId: true } } },
    });

    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        domain: row.domain,
        email: row.email,
        industry: row.industry,
        fieldProvenance: parseFieldProvenance(row.fieldProvenance),
        members: row.members.map((member) => member.externalSourceId).sort(),
      }))
      .sort((a, b) => (a.members[0] ?? "").localeCompare(b.members[0] ?? ""));
  }

  /** `kind:value` for every key in the tenant, sorted. */
  async function keyValues(): Promise<string[]> {
    const rows = await prisma.customerAccountKey.findMany({
      where: { userId: user.id },
      select: { kind: true, value: true },
    });
    return rows.map((row) => `${row.kind}:${row.value}`).sort();
  }

  /** The account each external id landed on, for absorb and move assertions. */
  async function placements(): Promise<Map<string, string | null>> {
    const rows = await prisma.customer.findMany({
      where: { integration: { userId: user.id } },
      select: { externalSourceId: true, customerAccountId: true },
    });
    return new Map(
      rows.map((row) => [row.externalSourceId, row.customerAccountId])
    );
  }

  return {
    userId: user.id,
    integrationId,
    customer,
    contact,
    updateCustomer,
    deleteConnection,
    groups,
    accounts,
    keyValues,
    placements,
  };
}

export type IdentityTenant = Awaited<ReturnType<typeof makeIdentityTenant>>;
