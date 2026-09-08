/**
 * The synthesized Stripe contact, and the epoch conversion.
 *
 * Stripe has no contact resource, so both the record and its id are ours.
 * `Contact` is unique on `(integrationId, externalSourceId)`, which means an
 * unstable id does not error — it inserts a duplicate person and orphans the old
 * row, quietly, on every sync. `epochToIso` guards a failure that is quieter
 * still: a create date that parses to null and simply never appears.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  epochToIso,
  parseCustomersPage,
  stripeContactExternalId,
  stripePageSize,
  synthesizeContact,
} from "@/core/providers/stripe/api";

afterEach(() => {
  // Left set, this would leak into every later test in the file — and into the
  // page-size default that one of them asserts.
  delete process.env["STRIPE_PAGE_SIZE"];
});

describe("stripeContactExternalId", () => {
  it("is a constant slot per customer", () => {
    expect(stripeContactExternalId("cus_123")).toBe("cus_123:contact");
  });

  it("does not depend on anything that can change", () => {
    // The contrast with Metrifox is the point: there is exactly one contact per
    // Stripe customer, so nothing needs disambiguating, and deriving the id
    // from the email would re-key the row on an address correction.
    const before = synthesizeContact({ id: "cus_1", name: "A", email: "a@x.test" });
    const after = synthesizeContact({ id: "cus_1", name: "B", email: "b@y.test" });
    expect(after?.["contact_id"]).toBe(before?.["contact_id"]);
  });
});

describe("synthesizeContact", () => {
  it("prefers the customer name", () => {
    const contact = synthesizeContact({
      id: "cus_1",
      name: "  Acme Manufacturing  ",
      email: "billing@acme.test",
    });
    expect(contact?.["contact_name"]).toBe("Acme Manufacturing");
    expect(contact?.["customer_name"]).toBe("Acme Manufacturing");
  });

  it("falls back to the email local part", () => {
    const contact = synthesizeContact({ id: "cus_1", email: "finance.team@vance.co.uk" });
    expect(contact?.["contact_name"]).toBe("finance.team");
  });

  it("uses the whole address when there is no local part to take", () => {
    const contact = synthesizeContact({ id: "cus_1", email: "@malformed" });
    // Kept rather than dropped: the record writer rejects a malformed email and
    // reports why, which is more useful than silently emitting no contact.
    expect(contact?.["contact_name"]).toBe("@malformed");
  });

  it("returns nothing when there is no name and no email", () => {
    expect(synthesizeContact({ id: "cus_1" })).toBeUndefined();
  });

  it("treats a whitespace-only name as absent", () => {
    // The record writer trims before checking that a name is present, so this
    // would be rejected for "Name is required" on every sync, forever.
    expect(synthesizeContact({ id: "cus_1", name: "   " })).toBeUndefined();
    expect(synthesizeContact({ id: "cus_1", name: "   ", email: "a@x.test" })).toBeDefined();
  });

  it("returns nothing without a customer id, since the association is the point", () => {
    expect(synthesizeContact({ name: "Acme", email: "a@x.test" })).toBeUndefined();
  });

  it("carries no customer id field of its own, so externalIdOf stays unambiguous", () => {
    const contact = synthesizeContact({ id: "cus_1", name: "Acme" });
    expect(contact).not.toHaveProperty("id");
    expect(contact?.["customer_id"]).toBe("cus_1");
  });
});

describe("epochToIso", () => {
  it("converts Unix seconds to an ISO string", () => {
    expect(epochToIso(1_680_893_993)).toBe("2023-04-07T18:59:53.000Z");
  });

  it("rejects everything that is not a finite number", () => {
    // Stripe sends a number; anything else means we are looking at a field that
    // is not what we think it is, and a guess would store a wrong date.
    expect(epochToIso("1680893993")).toBeUndefined();
    expect(epochToIso(undefined)).toBeUndefined();
    expect(epochToIso(null)).toBeUndefined();
    expect(epochToIso(Number.NaN)).toBeUndefined();
    expect(epochToIso(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("handles the epoch itself", () => {
    expect(epochToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("parseCustomersPage", () => {
  it("reads the list envelope", () => {
    const page = parseCustomersPage({
      object: "list",
      has_more: true,
      data: [{ id: "cus_1" }, { id: "cus_2" }],
    });
    expect(page.customers).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.lastId).toBe("cus_2");
  });

  it("does not require object:list", () => {
    // Treating it as a gate would turn a fixture that omits it into a clean,
    // silent, empty sync.
    const page = parseCustomersPage({ has_more: false, data: [{ id: "cus_1" }] });
    expect(page.customers).toHaveLength(1);
  });

  it("treats a non-boolean has_more as false", () => {
    // `Boolean("false")` is true, and providers do send strings.
    expect(parseCustomersPage({ has_more: "true", data: [] }).hasMore).toBe(false);
  });

  it("skips non-object rows and takes the last id that exists", () => {
    const page = parseCustomersPage({
      has_more: true,
      data: [{ id: "cus_1" }, "nonsense", { name: "no id here" }],
    });
    expect(page.customers).toHaveLength(2);
    expect(page.lastId).toBe("cus_1");
  });

  it("reports no cursor when nothing on the page has an id", () => {
    // The handler has to stop here: the only request it could make next is the
    // one it just made.
    expect(parseCustomersPage({ has_more: true, data: [{ name: "x" }] }).lastId).toBeUndefined();
  });

  it("tolerates a missing data array", () => {
    expect(parseCustomersPage({}).customers).toEqual([]);
    expect(parseCustomersPage(null).hasMore).toBe(false);
  });
});

describe("stripePageSize", () => {
  it("clamps to Stripe's documented maximum", () => {
    process.env["STRIPE_PAGE_SIZE"] = "500";
    expect(stripePageSize()).toBe(100);
  });

  it("falls back to the default on nonsense rather than to the maximum", () => {
    process.env["STRIPE_PAGE_SIZE"] = "not-a-number";
    expect(stripePageSize()).toBe(25);
    process.env["STRIPE_PAGE_SIZE"] = "0";
    expect(stripePageSize()).toBe(25);
    delete process.env["STRIPE_PAGE_SIZE"];
    expect(stripePageSize()).toBe(25);
  });
});
