/**
 * An imported crosswalk, from the paste box to the grouping it produces.
 *
 * This is the supply route for `payments_stripe_customers` — the join the spec
 * calls the thing that makes one `customer_account_id` possible, and which no
 * Metrifox endpoint exposes. Nothing else in the system can make it: the two
 * records share no email, no domain and no contact, so without the file they
 * are two companies and always will be.
 *
 * The load-bearing test here is not the join. It is that the pairs **survive a
 * re-sync**. The record writer overwrites `crossRefs` wholesale on every
 * upsert, so a human-supplied id stored in that column would work perfectly in
 * a demo and then vanish the first time the integration synced — with the
 * grouping quietly coming apart and nothing to point at.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "@/core/bootstrap";
import { resolveIdentities } from "@/core/identity/identity-resolver";
import {
  clearImportedCrossRefs,
  importCrosswalk,
  upsertAssertion,
} from "@/core/repositories/identity-repository";
import { prisma } from "@/lib/prisma";

import { makeIdentityTenant, type IdentityTenant } from "./identity-helpers";

beforeAll(() => {
  bootstrap();
});

/**
 * Two records for one company that share nothing at all.
 *
 * Different addresses on different domains, deliberately: any overlap would
 * let an email or domain key make the join and the crosswalk would prove
 * nothing.
 */
async function twoUnrelatedRecords(): Promise<{
  tenant: IdentityTenant;
  metrifoxId: string;
}> {
  const tenant = await makeIdentityTenant([
    { provider: "stripe" },
    { provider: "metrifox", metadata: { accountId: "acct-1" } },
  ]);

  await tenant.customer("stripe", "cus_tess", {
    name: "Tessellate Labs (UK)",
    email: "finance@tessellate-labs.example",
  });
  const metrifoxId = await tenant.customer("metrifox", "TESSELLATE-010", {
    name: "Tessellate Labs",
    email: "ap@tessellate.example",
    domain: "tessellate.example",
  });

  return { tenant, metrifoxId };
}

describe("importing pairs", () => {
  it("joins two records with no email or domain in common", async () => {
    const { tenant } = await twoUnrelatedRecords();

    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.groups()).toEqual([["cus_tess"], ["TESSELLATE-010"]]);

    await importCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);
  });

  it("records the key as imported, not as a mapping rule", async () => {
    const { tenant } = await twoUnrelatedRecords();
    await importCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await resolveIdentities(tenant.userId, "manual");

    const key = await prisma.customerAccountKey.findFirst({
      where: { userId: tenant.userId, source: "imported_crosswalk" },
      select: { kind: true, rawValue: true },
    });

    // Provenance is the whole reason the two sources are held in separate
    // columns. A user asking why two companies merged deserves "because you
    // uploaded a file saying so", not a claim about a field mapping that does
    // not exist.
    expect(key).toEqual({ kind: "external_ref", rawValue: "cus_tess" });
  });

  it("survives a re-sync of the integration that received it", async () => {
    const { tenant, metrifoxId } = await twoUnrelatedRecords();
    await importCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);

    // What the record writer does on every upsert: `crossRefs` is rewritten
    // from the mapping rules, which for this tenant produce nothing. An
    // imported pair kept in that column would be gone right here, and the
    // grouping would come apart on the next pass with no trace of why.
    await prisma.customer.update({
      where: { id: metrifoxId },
      data: { crossRefs: "{}" },
    });
    await resolveIdentities(tenant.userId, "manual");

    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);
  });

  it("reports ids that named no record here", async () => {
    const { tenant } = await twoUnrelatedRecords();

    const result = await importCrosswalk({
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [
        // A header row, which the parser deliberately does not try to detect.
        { localExternalId: "metrifox_id", foreignId: "stripe_id" },
        { localExternalId: "TESSELLATE-010", foreignId: "cus_tess" },
        { localExternalId: "NOT-SYNCED-YET", foreignId: "cus_other" },
      ],
    });

    // Not an error. A crosswalk covering a customer that has not synced yet is
    // ordinary, and failing the import over it would mean hand-filtering the
    // file before we will look at it. Reported, so a user whose columns were
    // the wrong way round finds out immediately.
    expect(result).toEqual({
      applied: 1,
      unmatched: ["metrifox_id", "NOT-SYNCED-YET"],
    });
  });

  it("keeps a second provider's pairs when a third is imported", async () => {
    const { tenant, metrifoxId } = await twoUnrelatedRecords();
    const base = {
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
    };

    await importCrosswalk({
      ...base,
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await importCrosswalk({
      ...base,
      foreignProvider: "hubspot",
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "9911" }],
    });

    // Merged rather than replaced: importing this month's Stripe file must not
    // silently discard last month's HubSpot one.
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: metrifoxId },
      select: { importedCrossRefs: true },
    });
    expect(JSON.parse(row.importedCrossRefs)).toEqual({
      stripe: "cus_tess",
      hubspot: "9911",
    });
  });

  it("lets a re-import correct a wrong id", async () => {
    const { tenant, metrifoxId } = await twoUnrelatedRecords();
    const base = {
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
    };

    await importCrosswalk({
      ...base,
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_wrong" }],
    });
    await importCrosswalk({
      ...base,
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });

    // Within one provider the newest import wins, because that is the only
    // reading under which a user can fix a typo without deleting first.
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: metrifoxId },
      select: { importedCrossRefs: true },
    });
    expect(JSON.parse(row.importedCrossRefs)).toEqual({ stripe: "cus_tess" });
  });
});

describe("withdrawing them", () => {
  /** Imported, resolved into one account, then the pairs taken back. */
  async function importedThenWithdrawn(): Promise<{
    tenant: IdentityTenant;
    metrifoxId: string;
  }> {
    const { tenant, metrifoxId } = await twoUnrelatedRecords();
    const base = {
      userId: tenant.userId,
      integrationId: tenant.integrationId("metrifox"),
      foreignProvider: "stripe",
    };

    await importCrosswalk({
      ...base,
      pairs: [{ localExternalId: "TESSELLATE-010", foreignId: "cus_tess" }],
    });
    await resolveIdentities(tenant.userId, "manual");
    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);

    expect(await clearImportedCrossRefs(base)).toBe(1);
    await resolveIdentities(tenant.userId, "manual");

    return { tenant, metrifoxId };
  }

  it("stops supplying the pair", async () => {
    const { tenant, metrifoxId } = await importedThenWithdrawn();

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: metrifoxId },
      select: { importedCrossRefs: true },
    });
    expect(JSON.parse(row.importedCrossRefs)).toEqual({});
  });

  it("does not, on its own, take the account back apart", async () => {
    const { tenant } = await importedThenWithdrawn();

    // The declared limit, and it is the same one the rest of the pass has: the
    // resolver merges on evidence but never *splits* on the absence of it.
    // Both records are members of that account now, each holding its own
    // self-key there, so removing the pair that introduced them changes
    // nothing about where they already are.
    //
    // That is the safe direction. Withdrawing a file is not the same statement
    // as "these are two companies" — the ids may have been right and the file
    // merely stale — and a pass that dissolved groupings whenever evidence
    // thinned would churn every account on every schema change at a provider.
    expect(await tenant.groups()).toEqual([["TESSELLATE-010", "cus_tess"]]);
  });

  it("leaves a `distinct` assertion able to finish the job", async () => {
    const { tenant, metrifoxId } = await importedThenWithdrawn();
    const stripeCustomer = await prisma.customer.findFirstOrThrow({
      where: { integrationId: tenant.integrationId("stripe") },
      select: { id: true },
    });

    await upsertAssertion({
      userId: tenant.userId,
      kind: "distinct",
      customerIdA: metrifoxId,
      customerIdB: stripeCustomer.id,
    });
    await resolveIdentities(tenant.userId, "manual");

    // So the withdrawal is not a dead end — it is one of two steps, and the
    // second is the same remedy every other "already merged" case uses. What
    // the withdrawal buys on its own is that the pair is never re-supplied, so
    // a *future* record carrying that id is not dragged in too.
    expect(await tenant.groups()).toEqual([["cus_tess"], ["TESSELLATE-010"]]);
  });
});

describe("ownership", () => {
  it("refuses an integration belonging to someone else", async () => {
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    const theirs = await makeIdentityTenant([{ provider: "metrifox" }]);
    await theirs.customer("metrifox", "THEIRS-001", { name: "Theirs" });

    const result = await importCrosswalk({
      userId: mine.userId,
      integrationId: theirs.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "THEIRS-001", foreignId: "cus_mine" }],
    });

    // `undefined`, not a zero-applied success. An unscoped write here would be
    // a way to attach a cross-reference to another tenant's customer and have
    // the next pass act on it — the severe failure this whole feature guards
    // against.
    expect(result).toBeUndefined();
    const row = await prisma.customer.findFirstOrThrow({
      where: { integrationId: theirs.integrationId("metrifox") },
      select: { importedCrossRefs: true },
    });
    expect(row.importedCrossRefs).toBe("{}");
  });

  it("clears nothing for an integration belonging to someone else", async () => {
    const mine = await makeIdentityTenant([{ provider: "stripe" }]);
    const theirs = await makeIdentityTenant([{ provider: "metrifox" }]);
    await theirs.customer("metrifox", "THEIRS-001", { name: "Theirs" });
    await importCrosswalk({
      userId: theirs.userId,
      integrationId: theirs.integrationId("metrifox"),
      foreignProvider: "stripe",
      pairs: [{ localExternalId: "THEIRS-001", foreignId: "cus_theirs" }],
    });

    expect(
      await clearImportedCrossRefs({
        userId: mine.userId,
        integrationId: theirs.integrationId("metrifox"),
        foreignProvider: "stripe",
      })
    ).toBe(0);

    const row = await prisma.customer.findFirstOrThrow({
      where: { integrationId: theirs.integrationId("metrifox") },
      select: { importedCrossRefs: true },
    });
    expect(JSON.parse(row.importedCrossRefs)).toEqual({ stripe: "cus_theirs" });
  });
});
