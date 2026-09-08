/**
 * The synthesized contact id.
 *
 * Metrifox's nested `contact_people[]` carry no id of their own, so we make
 * one. `Contact` is unique on `(integrationId, externalSourceId)`, which means
 * an unstable id does not error — it inserts a duplicate person and orphans the
 * old row, quietly, on every sync. These are the tests that keep that honest.
 */

import { describe, expect, it } from "vitest";
import {
  flattenContacts,
  metrifoxContactExternalId,
} from "@/core/providers/metrifox/api";

const CUSTOMER = "cust-1";

function person(fields: Record<string, unknown> = {}) {
  return { first_name: "", last_name: "", email_address: null, ...fields };
}

describe("metrifoxContactExternalId", () => {
  it("prefers the email, normalised", () => {
    const id = metrifoxContactExternalId(
      CUSTOMER,
      person({ email_address: "  Dana@Example.COM " }),
      0,
      new Set()
    );
    expect(id).toBe("cust-1:dana@example.com");
  });

  it("falls back to the name when there is no email", () => {
    const id = metrifoxContactExternalId(
      CUSTOMER,
      person({ first_name: "Tobias", last_name: "Lund", designation: "Head of Data" }),
      3,
      new Set()
    );
    expect(id).toBe("cust-1:tobias|lund|head of data");
  });

  it("falls back to the index only when there is nothing else", () => {
    const id = metrifoxContactExternalId(CUSTOMER, person(), 4, new Set());
    expect(id).toBe("cust-1:#4");
  });

  it("suffixes a collision, leaving the first occurrence untouched", () => {
    const taken = new Set<string>();
    const first = metrifoxContactExternalId(
      CUSTOMER,
      person({ email_address: "ap@x.example" }),
      0,
      taken
    );
    taken.add(first);
    const second = metrifoxContactExternalId(
      CUSTOMER,
      person({ email_address: "ap@x.example" }),
      1,
      taken
    );

    expect(first).toBe("cust-1:ap@x.example");
    expect(second).toBe("cust-1:ap@x.example#1");
  });

  it("keeps the same person under two customers distinct", () => {
    const shared = person({ email_address: "consultant@x.example" });
    const a = metrifoxContactExternalId("cust-a", shared, 0, new Set());
    const b = metrifoxContactExternalId("cust-b", shared, 0, new Set());

    // Correct, not a bug: our Contact holds exactly one customerId, and the
    // source really is asserting two distinct relationships.
    expect(a).not.toBe(b);
  });

  it("does not move when the index changes", () => {
    const p = person({ email_address: "stable@x.example" });
    expect(metrifoxContactExternalId(CUSTOMER, p, 0, new Set())).toBe(
      metrifoxContactExternalId(CUSTOMER, p, 9, new Set())
    );
  });
});

describe("flattenContacts", () => {
  it("joins the name and carries the association", () => {
    const [contact] = flattenContacts({
      id: CUSTOMER,
      customer_key: "KEY-1",
      contact_people: [
        { first_name: "Dana", last_name: "Whitfield", email_address: "d@x.example" },
      ],
    });

    expect(contact?.["full_name"]).toBe("Dana Whitfield");
    expect(contact?.["customer_id"]).toBe(CUSTOMER);
    expect(contact?.["customer_key"]).toBe("KEY-1");
  });

  it("joins a one-sided name without a stray space", () => {
    const [contact] = flattenContacts({
      id: CUSTOMER,
      contact_people: [{ first_name: "Cher", last_name: "", email_address: null }],
    });
    expect(contact?.["full_name"]).toBe("Cher");
  });

  it("returns nothing for a customer with no id", () => {
    expect(
      flattenContacts({ contact_people: [{ first_name: "Orphan" }] })
    ).toEqual([]);
  });

  it("tolerates a missing or malformed contact_people array", () => {
    expect(flattenContacts({ id: CUSTOMER })).toEqual([]);
    expect(flattenContacts({ id: CUSTOMER, contact_people: "nope" })).toEqual([]);
    expect(
      flattenContacts({ id: CUSTOMER, contact_people: [null, 42] })
    ).toEqual([]);
  });
});
