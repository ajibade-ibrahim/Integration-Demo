import { describe, expect, it } from "vitest";

import type { KnownParties, KnownPartyCandidate } from "@/core/communication/known-parties";
import { matchMessage } from "@/core/communication/matching";

function candidate(
  overrides: Partial<KnownPartyCandidate> & Pick<KnownPartyCandidate, "partyKey" | "matchKind">
): KnownPartyCandidate {
  return {
    matchedValue: "alice@acme.example",
    rank: 3,
    priority: 100,
    ...overrides,
  };
}

function parties(input: {
  emails?: Record<string, KnownPartyCandidate[]>;
  domains?: Record<string, KnownPartyCandidate[]>;
}): KnownParties {
  return {
    byEmail: new Map(Object.entries(input.emails ?? {})),
    byDomain: new Map(Object.entries(input.domains ?? {})),
    rawEmails: Object.keys(input.emails ?? {}),
    domains: Object.keys(input.domains ?? {}),
    fingerprint: "fp",
    isEmpty: false,
  };
}

describe("communication matching", () => {
  it("prefers a contact email over a customer email in the same account", () => {
    const result = matchMessage({
      knownParties: parties({
        emails: {
          "alice@acme.example": [
            candidate({
              partyKey: "contact:c1",
              contactId: "c1",
              customerId: "customer-1",
              customerAccountId: "account-1",
              matchKind: "contact_email",
            }),
            candidate({
              partyKey: "account:account-1",
              customerId: "customer-1",
              customerAccountId: "account-1",
              matchKind: "customer_email",
              rank: 2,
            }),
          ],
        },
      }),
      addresses: { from: ["alice@acme.example"], to: [], cc: [] },
    });

    expect(result?.participants).toHaveLength(2);
    expect(result?.primaryPartyKey).toBe("contact:c1");
    expect(result?.participants.find((p) => p.isPrimary)).toMatchObject({
      role: "from",
      matchKind: "contact_email",
    });
  });

  it("stores both top candidates and chooses no primary when accounts disagree", () => {
    const result = matchMessage({
      knownParties: parties({
        emails: {
          "alice@acme.example": [
            candidate({
              partyKey: "customer:a",
              customerId: "a",
              customerAccountId: "account-a",
              matchKind: "customer_email",
              rank: 2,
            }),
            candidate({
              partyKey: "customer:b",
              customerId: "b",
              customerAccountId: "account-b",
              matchKind: "customer_email",
              rank: 2,
            }),
          ],
        },
      }),
      addresses: { from: [], to: ["alice@acme.example"], cc: [] },
    });

    expect(result?.primaryPartyKey).toBeUndefined();
    expect(result?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partyKey: "customer:a", disputed: true, isPrimary: false }),
        expect.objectContaining({ partyKey: "customer:b", disputed: true, isPrimary: false }),
      ])
    );
  });

  it("matches an exact host domain but not a subdomain", () => {
    const result = matchMessage({
      knownParties: parties({
        domains: {
          "acme.example": [
            candidate({
              partyKey: "customer:a",
              customerId: "a",
              matchKind: "customer_domain",
              matchedValue: "acme.example",
              rank: 1,
            }),
          ],
        },
      }),
      addresses: { from: ["person@retail.acme.example"], to: [], cc: [] },
    });

    expect(result).toBeUndefined();
  });

  it("never attributes the mailbox owner", () => {
    const result = matchMessage({
      knownParties: parties({
        emails: {
          "owner@our-company.example": [
            candidate({
              partyKey: "customer:self",
              customerId: "self",
              matchKind: "customer_email",
              matchedValue: "owner@our-company.example",
            }),
          ],
        },
      }),
      addresses: {
        from: ["owner@our-company.example"],
        to: ["alice@acme.example"],
        cc: [],
      },
      mailboxEmail: "owner@our-company.example",
    });

    expect(result).toBeUndefined();
  });
});
