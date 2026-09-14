/**
 * The account-level email, end to end through the real write path.
 *
 * Stripe and Metrifox are the only two providers that supply a company address,
 * and their defaults used to park it in `customFields` — a serialized JSON
 * string column that identity resolution cannot query or index. These tests pin
 * the retargeting: the address must land in `Customer.email`, and it must land
 * there by way of the shipped defaults rather than a rule invented here, because
 * the defaults are what a real integration actually gets seeded with.
 *
 * The malformed-address case is the one worth reading. A contact with a broken
 * email is *rejected* by `writeContacts`; a customer with a broken email is
 * warned about and nulled. That asymmetry is deliberate — a customer's identity
 * is its name and provider id, so discarding a whole company over one bad field
 * would be a worse outcome than an empty column — and it is exactly the sort of
 * decision that gets "tidied" into consistency by a later reader unless a test
 * says otherwise.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { applyMappings } from "@/core/field-mapper/field-mapper";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { createIntegration } from "@/core/repositories/integration-repository";
import { writeCustomers } from "@/core/sync/record-writer";
import { prisma } from "@/lib/prisma";
import type { RawRecord } from "@/core/types/common";

/** One integration per provider, so a test can write as any of them. */
const integrationIds = new Map<string, string>();

beforeEach(async () => {
  integrationIds.clear();

  const user = await prisma.user.create({
    data: { email: `account-email-${randomUUID()}@test.local` },
    select: { id: true },
  });

  for (const providerName of ["stripe", "metrifox", "hubspot"]) {
    const integration = await createIntegration({
      userId: user.id,
      providerName,
      functionNames: ["identity"],
      instanceLabel: `${providerName} — account email`,
    });
    integrationIds.set(providerName, integration.id);
  }
});

/**
 * Write one source record through that provider's *shipped* defaults.
 *
 * Going through `defaultMappingsFor` rather than a hand-written rule is the
 * point: it is what proves the default itself was retargeted, not merely that
 * the column exists.
 */
async function writeAs(providerName: string, record: RawRecord) {
  const integrationId = integrationIds.get(providerName);
  if (integrationId === undefined) throw new Error(`no integration for ${providerName}`);

  const rules = defaultMappingsFor("identity", providerName);
  const mapped = applyMappings(rules, "customer", record);

  const result = await writeCustomers(integrationId, [
    { externalSourceId: String(record["id"]), mapped },
  ]);

  const row = await prisma.customer.findUnique({
    where: {
      integrationId_externalSourceId: {
        integrationId,
        externalSourceId: String(record["id"]),
      },
    },
  });

  return { result, row };
}

describe("Stripe", () => {
  it("lands `email` in the first-class column, not customFields", async () => {
    const { result, row } = await writeAs("stripe", {
      id: "cus_acme",
      name: "Acme Corp",
      email: "Billing@Acme.example",
    });

    expect(result.written).toBe(1);
    expect(row?.email).toBe("billing@acme.example");
    // The address must not *also* be duplicated into the JSON blob — having it
    // in both places would double-store and let the two drift.
    expect(row?.customFields).not.toContain("billing@acme.example");
  });
});

describe("Metrifox", () => {
  it("lands `primary_email` in the first-class column", async () => {
    // The literal from the shipped Metrifox fixtures — a role address, which is
    // exactly what the spec says to seed the identity table from.
    const { row } = await writeAs("metrifox", {
      id: "MF-ACME",
      display_name: "Acme Industries",
      primary_email: "billing@acme.example",
      website_url: "https://www.acme.example/pricing",
    });

    expect(row?.email).toBe("billing@acme.example");
    expect(row?.domain).toBe("acme.example");
  });

  it("leaves email null when the source carries none", async () => {
    // MERIDIAN-005 in the fixtures has primary_email: null. A missing address
    // is ordinary, not an error.
    const { result, row } = await writeAs("metrifox", {
      id: "MF-MERIDIAN",
      display_name: "Meridian",
      primary_email: null,
      website_url: "https://meridian.example",
    });

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);
    expect(row?.email).toBeNull();
  });
});

describe("a malformed account email", () => {
  it("is warned about and nulled — the company is still written", async () => {
    const { result, row } = await writeAs("stripe", {
      id: "cus_broken",
      name: "Broken Email Ltd",
      email: "not-an-email",
    });

    // The company survives. This is the assertion that matters.
    expect(result.written).toBe(1);
    expect(row).not.toBeNull();
    expect(row?.name).toBe("Broken Email Ltd");
    expect(row?.email).toBeNull();

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      sourceRecordId: "cus_broken",
      targetObject: "customer",
      fieldName: "email",
      severity: "warning",
    });
  });

  it("agrees with the resolver about what is malformed", async () => {
    // `sasha.brenner@harbour` — a real Metrifox fixture address with a dotless
    // domain. The writer and the matcher share EMAIL_PATTERN precisely so the
    // writer cannot store something the matcher would then refuse to join on.
    const { row, result } = await writeAs("metrifox", {
      id: "MF-HARBOUR",
      display_name: "Harbour",
      primary_email: "sasha.brenner@harbour",
    });

    expect(row?.email).toBeNull();
    expect(result.issues[0]?.severity).toBe("warning");
  });
});

describe("providers with no account-level address", () => {
  it("writes a HubSpot company with a null email and no complaint", async () => {
    // HubSpot companies carry `domain`, not an address. Null here is the
    // expected steady state for three of the five providers, so it must not
    // read as a problem.
    const { result, row } = await writeAs("hubspot", {
      id: "12345",
      properties: {
        name: "Acme Manufacturing",
        domain: "acme-mfg.com",
        industry: "Manufacturing",
      },
    });

    expect(result.written).toBe(1);
    expect(result.issues).toEqual([]);
    expect(row?.email).toBeNull();
    expect(row?.domain).toBe("acme-mfg.com");
  });
});
