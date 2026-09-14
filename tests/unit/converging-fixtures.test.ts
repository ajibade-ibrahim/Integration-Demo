/**
 * The demo data actually converges.
 *
 * Identity resolution is the one feature whose demo cannot be faked by the UI:
 * if the three fixture sets share no key, the Accounts tab shows three separate
 * companies and the whole thing looks broken. The fixtures were separate
 * universes by design before this — mock Acme is `acme-mfg.com` where Metrifox
 * Acme is `acme.example`, even for the same person — so the convergence is a
 * deliberate property of three files that are edited independently and have no
 * compiler relationship at all.
 *
 * These assertions are the relationship. Each one names the *route* the join
 * takes, so a fixture edit that quietly removes one fails here rather than in a
 * demo.
 *
 * Nothing here asserts that resolution works; that is covered against a real
 * database. This is about the data being shaped so there is something to
 * resolve.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { domainFromUrl } from "@/core/field-mapper/transforms";
import { MOCK_COMPANIES, MOCK_PEOPLE } from "@/core/providers/mock/fixtures";
import { METRIFOX_CUSTOMERS } from "@/core/providers/metrifox/fixtures";

interface StripeFixture {
  name: string;
  params: { name?: string; email?: string };
}

const STRIPE_FIXTURES: StripeFixture[] = (
  JSON.parse(
    readFileSync("scripts/stripe-sandbox-fixtures.json", "utf8")
  ) as { fixtures: StripeFixture[] }
).fixtures;

function stripe(name: string): StripeFixture {
  const found = STRIPE_FIXTURES.find((fixture) => fixture.name === name);
  if (found === undefined) throw new Error(`No Stripe fixture "${name}"`);
  return found;
}

function mock(id: string) {
  const found = MOCK_COMPANIES.find((company) => company.id === id);
  if (found === undefined) throw new Error(`No mock company "${id}"`);
  return found;
}

function metrifox(customerKey: string) {
  const found = METRIFOX_CUSTOMERS.find(
    (customer) => customer.customer_key === customerKey
  );
  if (found === undefined) throw new Error(`No Metrifox customer "${customerKey}"`);
  return found;
}

describe("Ridgeline — the three-source company", () => {
  it("joins Metrifox to Stripe on a shared email", () => {
    // Stripe has no website field at all, so an address is the only route it
    // has. This is why email is a key kind and not just domain.
    expect(metrifox("RIDGELINE-009").primary_email).toBe(
      stripe("cus_ridgeline").params.email
    );
  });

  it("joins Metrifox to the CRM on a shared domain", () => {
    // Different URLs, same host — which is the point of normalizing rather
    // than comparing the mapped column as written.
    expect(domainFromUrl(metrifox("RIDGELINE-009").website_url ?? "")).toBe(
      domainFromUrl(mock("c-009").properties["website"] ?? "")
    );
  });

  it("has all three sources disagreeing on the name", () => {
    // At equal priority, which is what raises the `field_conflict` the
    // Accounts tab's second banner exists to explain. Without a disagreement
    // that banner is unreachable in the demo.
    const names = [
      metrifox("RIDGELINE-009").display_name,
      mock("c-009").properties["name"],
      stripe("cus_ridgeline").params.name,
    ];
    expect(new Set(names).size).toBe(3);
  });
});

describe("Tessellate — the crosswalk-only company", () => {
  it("joins Metrifox to the CRM on a shared domain", () => {
    expect(domainFromUrl(metrifox("TESSELLATE-010").website_url ?? "")).toBe(
      domainFromUrl(mock("c-010").properties["website"] ?? "")
    );
  });

  it("gives Stripe no email or domain route in at all", () => {
    // The load-bearing assertion of this file. `crossRef.stripe` only
    // demonstrates anything if it is the *sole* way to reach the Stripe
    // record — an overlapping address here would let an ordinary email key
    // make the join and the crosswalk would prove nothing.
    const stripeEmail = stripe("cus_tessellate").params.email ?? "";

    expect(stripeEmail).not.toBe(metrifox("TESSELLATE-010").primary_email);
    expect(domainOf(stripeEmail)).not.toBe(
      domainFromUrl(metrifox("TESSELLATE-010").website_url ?? "")
    );
    for (const person of metrifox("TESSELLATE-010").contact_people) {
      expect(person.email_address).not.toBe(stripeEmail);
    }
  });

  it("carries a placeholder Stripe id, because a real one cannot be a fixture", () => {
    // Stripe assigns `cus_...` at creation time, so this can only ever be
    // filled in against a sandbox that has actually been seeded — see
    // `METRIFOX_FAKE_STRIPE_IDS` in the fake's route. What matters is that the
    // field is *present and mapped*, so the route is live rather than
    // theoretical.
    expect(metrifox("TESSELLATE-010").stripe_customer_id).toMatch(/^cus_/);
  });
});

describe("Halcyon — the contact-email company", () => {
  it("joins the CRM to Stripe through a contact, not an account field", () => {
    // The universal route: all five providers map `contact.email`, while only
    // two carry an account-level one. A CRM with no billing address on the
    // company reaches a payment processor exactly this way.
    const contact = MOCK_PEOPLE.find((person) => person.id === "p-021");

    expect(contact?.companyId).toBe("c-011");
    expect(contact?.properties["email"]).toBe(stripe("cus_halcyon").params.email);
    expect(mock("c-011").properties["email"]).toBeUndefined();
  });
});

describe("the existing fixtures", () => {
  it("still lead with the eight awkward Metrifox records, unchanged", () => {
    // Added to rather than edited. Each of these exercises a rejection or
    // warning branch that a handler test pins, and retuning them to converge
    // would have cost that coverage to buy this.
    expect(
      METRIFOX_CUSTOMERS.slice(0, 8).map((customer) => customer.customer_key)
    ).toEqual([
      "ACME-001",
      "NORTHWIND-002",
      "HARBOUR-003",
      "SOLO-004",
      "MERIDIAN-005",
      "CEDAR-006",
      "QUANTA-007",
      "LATTICE-008",
    ]);
  });

  it("still lead with the eight original mock companies", () => {
    expect(MOCK_COMPANIES.slice(0, 8).map((company) => company.id)).toEqual([
      "c-001",
      "c-002",
      "c-003",
      "c-004",
      "c-005",
      "c-006",
      "c-007",
      "c-008",
    ]);
  });

  it("still seed Stripe's deliberately-bad record last", () => {
    // If Stripe ever starts rejecting it at creation time, everything before
    // it has already been created. Inserting the converging three ahead of it
    // preserves that.
    expect(STRIPE_FIXTURES[STRIPE_FIXTURES.length - 1]?.name).toBe(
      "cus_no_name_no_email"
    );
  });
});

/** The host of an email address, for "these do not overlap" assertions. */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}
