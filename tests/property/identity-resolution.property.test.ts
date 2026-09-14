/**
 * The invariants the resolution pass claims in its own header.
 *
 * Property-tested rather than example-tested because every one of them is about
 * *arrangement* — which customers share which key, which integration synced
 * first, what order Postgres handed the rows back. An example test picks one
 * arrangement and pins it; these generate the arrangement and assert the
 * outcome does not depend on it.
 *
 * Run counts are low on purpose. Each case builds a tenant in a real Postgres
 * and runs two full passes over it, so a hundred runs would be minutes of wall
 * clock for coverage that a dozen structurally different shapes already gives.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import { prisma } from "@/lib/prisma";

beforeAll(() => {
  // The pass reads `externalIdScope` off the provider definitions.
  bootstrap();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Generated shapes
// ---------------------------------------------------------------------------

/**
 * One real company, as several systems see it.
 *
 * `sharedEmail` is what should join the members. Domains are deliberately not
 * generated as the only link, because a domain key is the weakest kind and the
 * point of these properties is the partition, not the ranking.
 */
interface Company {
  slug: string;
  members: { provider: string; externalId: string; hasEmail: boolean }[];
}

const providerArb = fc.constantFrom("stripe", "mock");

function companiesArb(): fc.Arbitrary<Company[]> {
  return fc
    .array(
      fc.record({
        members: fc.array(
          fc.record({ provider: providerArb, hasEmail: fc.boolean() }),
          { minLength: 1, maxLength: 3 }
        ),
      }),
      { minLength: 1, maxLength: 4 }
    )
    .map((raw) =>
      raw.map((company, i) => ({
        slug: `co${i}`,
        members: company.members.map((member, j) => ({
          provider: member.provider,
          // Unique per tenant, so a self-key never joins two companies by
          // accident and the generated email is the only intended link.
          externalId: `co${i}-m${j}`,
          hasEmail: member.hasEmail,
        })),
      }))
    );
}

// ---------------------------------------------------------------------------
// Building a tenant
// ---------------------------------------------------------------------------

interface Tenant {
  userId: string;
  /** customer id -> the company slug it was generated from. */
  expected: Map<string, string>;
}

/**
 * Write the generated companies into a fresh user.
 *
 * @param insertionOrder Which order the customer rows are created in. The whole
 *   point of one property below: the pass sorts its input canonically, so this
 *   must not be observable in the result.
 */
async function buildTenant(
  companies: readonly Company[],
  insertionOrder: "forward" | "reverse" = "forward",
  priorities: Record<string, number> = {}
): Promise<Tenant> {
  const user = await prisma.user.create({
    data: { email: `identity-prop-${randomUUID()}@test.local` },
    select: { id: true },
  });

  const integrationIds = new Map<string, string>();
  for (const provider of ["stripe", "mock"]) {
    const integration = await prisma.integration.create({
      data: {
        userId: user.id,
        providerName: provider,
        status: "active",
        instanceLabel: `${provider} — property`,
        identityPriority: priorities[provider] ?? 100,
      },
      select: { id: true },
    });
    integrationIds.set(provider, integration.id);
  }

  const rows = companies.flatMap((company) =>
    company.members.map((member) => ({ company, member }))
  );
  const ordered = insertionOrder === "forward" ? rows : [...rows].reverse();

  const expected = new Map<string, string>();
  for (const { company, member } of ordered) {
    const row = await prisma.customer.create({
      data: {
        integrationId: integrationIds.get(member.provider)!,
        externalSourceId: member.externalId,
        name: `${company.slug} via ${member.provider}`,
        // Every member of a company carries the same address, so the pass has
        // an email key to join them on. A member without one is the interesting
        // case: it can only be reached by its own self-key, so it stays apart.
        email: member.hasEmail ? `billing@${company.slug}.example` : null,
      },
      select: { id: true },
    });
    expected.set(row.id, member.hasEmail ? company.slug : `${company.slug}/${member.externalId}`);
  }

  return { userId: user.id, expected };
}

/** The partition the pass produced, as sets of customer ids. */
async function partitionOf(userId: string): Promise<string[][]> {
  const customers = await prisma.customer.findMany({
    where: { integration: { userId } },
    select: { id: true, customerAccountId: true, externalSourceId: true },
  });

  const groups = new Map<string, string[]>();
  for (const customer of customers) {
    const key = customer.customerAccountId ?? "UNLINKED";
    groups.set(key, [...(groups.get(key) ?? []), customer.externalSourceId]);
  }

  // Keyed by content, not by account id — two runs produce different uuids for
  // the same grouping, and it is the grouping that has to match.
  return [...groups.values()].map((ids) => ids.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("resolution is total", () => {
  it("leaves every customer linked to an account", async () => {
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const tenant = await buildTenant(companies);
        await resolveIdentities(tenant.userId, "manual");

        const unlinked = await prisma.customer.count({
          where: { integration: { userId: tenant.userId }, customerAccountId: null },
        });

        // The pass's own "done when". A record with no usable key gets a
        // singleton rather than being skipped, so a null here means resolution
        // did not run — not that the record was unmatchable.
        expect(unlinked).toBe(0);
      }),
      { numRuns: 12 }
    );
  });
});

describe("resolution is idempotent", () => {
  it("creates nothing and moves nobody on a second pass", async () => {
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const tenant = await buildTenant(companies);
        await resolveIdentities(tenant.userId, "manual");
        const first = await partitionOf(tenant.userId);
        const accountIds = await accountIdSet(tenant.userId);

        const second = await resolveIdentities(tenant.userId, "manual");

        expect(await partitionOf(tenant.userId)).toEqual(first);
        // Ids are stable too, not just the shape. A pass that reaped and
        // recreated the same grouping would satisfy the partition check while
        // orphaning every row that references an account id.
        expect(await accountIdSet(tenant.userId)).toEqual(accountIds);
        expect(second.counts.accountsCreated).toBe(0);
        expect(second.counts.accountsAbsorbed).toBe(0);
        expect(second.counts.accountsReaped).toBe(0);
      }),
      { numRuns: 12 }
    );
  });
});

describe("resolution is order-independent", () => {
  it("partitions two tenants identically whichever order rows arrived in", async () => {
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const forward = await buildTenant(companies, "forward");
        const reverse = await buildTenant(companies, "reverse");

        await resolveIdentities(forward.userId, "manual");
        await resolveIdentities(reverse.userId, "manual");

        // Compared by externalSourceId, which is the same in both tenants —
        // the internal uuids are not, and neither is insertion order.
        expect(await partitionOf(reverse.userId)).toEqual(
          await partitionOf(forward.userId)
        );
      }),
      { numRuns: 10 }
    );
  });
});

describe("the partition matches the generated companies", () => {
  it("groups members that share an address and separates those that do not", async () => {
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const tenant = await buildTenant(companies);
        await resolveIdentities(tenant.userId, "manual");

        const customers = await prisma.customer.findMany({
          where: { integration: { userId: tenant.userId } },
          select: { id: true, customerAccountId: true },
        });

        for (const a of customers) {
          for (const b of customers) {
            if (a.id === b.id) continue;
            const together = a.customerAccountId === b.customerAccountId;
            const shouldBe =
              tenant.expected.get(a.id) === tenant.expected.get(b.id);
            expect(together).toBe(shouldBe);
          }
        }
      }),
      { numRuns: 12 }
    );
  });
});

describe("precedence settles values, never membership", () => {
  it("keeps the partition byte-identical when priorities are reversed", async () => {
    // The safety property the whole design rests on. If precedence could
    // repartition, changing a rank would silently regroup a user's customer
    // list — and they would have no way to connect the two events.
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const low = await buildTenant(companies, "forward", {
          stripe: 1,
          mock: 900,
        });
        const high = await buildTenant(companies, "forward", {
          stripe: 900,
          mock: 1,
        });

        await resolveIdentities(low.userId, "manual");
        await resolveIdentities(high.userId, "manual");

        expect(await partitionOf(high.userId)).toEqual(
          await partitionOf(low.userId)
        );
      }),
      { numRuns: 10 }
    );
  });
});

describe("integrations arriving one at a time converge", () => {
  it("reaches the same partition as if everything had synced at once", async () => {
    // The absorb path, and the reason it is the common case rather than an
    // optimization: the first integration to sync has already been given
    // singleton accounts by the time the second one arrives. Without absorb,
    // whichever connector the user happened to set up first would permanently
    // decide the grouping.
    await fc.assert(
      fc.asyncProperty(companiesArb(), async (companies) => {
        const allAtOnce = await buildTenant(companies);
        await resolveIdentities(allAtOnce.userId, "manual");

        const staged = await buildTenantStaged(companies);

        expect(await partitionOf(staged.userId)).toEqual(
          await partitionOf(allAtOnce.userId)
        );
      }),
      { numRuns: 10 }
    );
  });
});

describe("a record that gains a key later still moves", () => {
  it("joins the account it now matches, rather than being pinned by its own self-key", async () => {
    // The regression this exists for: every customer contributes a self-key,
    // that key is an `external_ref`, and `external_ref` outranks `email`. So a
    // customer's own account wins every strength contest against the account
    // its new address actually matches, and the record can never move again —
    // it sits alone forever while the pass reports a key conflict. Caught only
    // by a second pass over *changed* data, which is why the properties above
    // did not find it.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("stripe", "mock"),
        async (lateProvider) => {
          const user = await prisma.user.create({
            data: { email: `identity-late-${randomUUID()}@test.local` },
            select: { id: true },
          });

          const integrations = new Map<string, string>();
          for (const provider of ["stripe", "mock"]) {
            const row = await prisma.integration.create({
              data: {
                userId: user.id,
                providerName: provider,
                status: "active",
                instanceLabel: `${provider} — late`,
              },
              select: { id: true },
            });
            integrations.set(provider, row.id);
          }

          const settled = await prisma.customer.create({
            data: {
              integrationId: integrations.get("stripe")!,
              externalSourceId: "cus_settled",
              name: "Settled",
              email: "billing@acme.example",
            },
            select: { id: true },
          });
          const late = await prisma.customer.create({
            data: {
              integrationId: integrations.get(lateProvider)!,
              externalSourceId: "late-1",
              name: "Late",
            },
            select: { id: true },
          });

          const first = await resolveIdentities(user.id, "manual");
          expect(first.counts.accountsCreated).toBe(2);

          await prisma.customer.update({
            where: { id: late.id },
            data: { email: "billing@acme.example" },
          });
          const second = await resolveIdentities(user.id, "manual");

          const rows = await prisma.customer.findMany({
            where: { id: { in: [settled.id, late.id] } },
            select: { customerAccountId: true },
          });
          expect(new Set(rows.map((r) => r.customerAccountId)).size).toBe(1);

          // Absorbed, not left behind for the reaper — so the old account's
          // keys came with it instead of being deleted and re-indexed.
          expect(second.counts.accountsAbsorbed).toBe(1);

          // No key was reported as contested. The two records disagree on
          // `name` at equal priority, which is a `field_conflict` and correct —
          // but a `key_claimed_elsewhere` here would mean the merge had been
          // refused rather than made.
          expect(second.issues.map((i) => i.kind)).toEqual(["field_conflict"]);
        }
      ),
      { numRuns: 2 }
    );
  });
});

/**
 * Build the same tenant, but resolve after each provider's rows land.
 *
 * Mirrors what actually happens: a user connects Stripe, syncs, and connects
 * the CRM a week later.
 */
async function buildTenantStaged(companies: readonly Company[]): Promise<Tenant> {
  const user = await prisma.user.create({
    data: { email: `identity-prop-${randomUUID()}@test.local` },
    select: { id: true },
  });

  const expected = new Map<string, string>();

  for (const provider of ["stripe", "mock"]) {
    const integration = await prisma.integration.create({
      data: {
        userId: user.id,
        providerName: provider,
        status: "active",
        instanceLabel: `${provider} — staged`,
      },
      select: { id: true },
    });

    for (const company of companies) {
      for (const member of company.members) {
        if (member.provider !== provider) continue;
        const row = await prisma.customer.create({
          data: {
            integrationId: integration.id,
            externalSourceId: member.externalId,
            name: `${company.slug} via ${member.provider}`,
            email: member.hasEmail ? `billing@${company.slug}.example` : null,
          },
          select: { id: true },
        });
        expected.set(
          row.id,
          member.hasEmail ? company.slug : `${company.slug}/${member.externalId}`
        );
      }
    }

    // Resolve between connections, not just at the end.
    await resolveIdentities(user.id, "sync");
  }

  return { userId: user.id, expected };
}

async function accountIdSet(userId: string): Promise<string[]> {
  const accounts = await prisma.customerAccount.findMany({
    where: { userId },
    select: { id: true },
  });
  return accounts.map((a) => a.id).sort();
}
