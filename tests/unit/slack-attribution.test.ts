import { describe, expect, it } from "vitest";

import type {
  KnownParties,
  KnownPartyCandidate,
} from "@/core/communication/known-parties";
import { matchAuthorContactsForCustomer } from "@/core/communication/matching";
import type { SlackConversationMappingView } from "@/core/communication/types";
import { buildSlackAttribution } from "@/core/providers/slack/communication-handler";

function candidate(
  overrides: Partial<KnownPartyCandidate> &
    Pick<KnownPartyCandidate, "partyKey" | "matchKind">
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
  mailboxEmail?: string;
}): KnownParties {
  return {
    byEmail: new Map(Object.entries(input.emails ?? {})),
    byDomain: new Map(Object.entries(input.domains ?? {})),
    rawEmails: Object.keys(input.emails ?? {}),
    domains: Object.keys(input.domains ?? {}),
    ...(input.mailboxEmail === undefined
      ? {}
      : { mailboxEmail: input.mailboxEmail }),
    fingerprint: "fp",
    isEmpty: false,
  };
}

const MAPPING: SlackConversationMappingView = {
  mappingId: "mapping-1",
  conversationId: "C-shared",
  conversationKind: "shared_channel",
  label: "#acme-support",
  customerId: "customer-a",
  customerName: "Acme",
  customerAccountId: "account-a",
};

function aliceInTwoCompanies(): KnownParties {
  return parties({
    emails: {
      "alice@acme.example": [
        candidate({
          partyKey: "contact:a",
          contactId: "contact-a",
          customerId: "customer-a",
          customerAccountId: "account-a",
          matchKind: "contact_email",
        }),
        candidate({
          partyKey: "contact:b",
          contactId: "contact-b",
          customerId: "customer-b",
          customerAccountId: "account-b",
          matchKind: "contact_email",
        }),
      ],
    },
  });
}

describe("conversation-mapped attribution", () => {
  it("attributes the message to the mapped customer only", () => {
    const attribution = buildSlackAttribution({
      mapping: MAPPING,
      authorExternal: false,
      knownParties: aliceInTwoCompanies(),
    });

    expect(attribution).toMatchObject({
      kind: "slack",
      mappingId: "mapping-1",
      customerId: "customer-a",
      authorExternal: false,
    });
    expect(attribution.authorContact).toBeUndefined();
  });

  it("adds only contacts belonging to the mapped customer", () => {
    const contacts = matchAuthorContactsForCustomer({
      knownParties: aliceInTwoCompanies(),
      addresses: ["alice@acme.example"],
      customerId: "customer-a",
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      partyKey: "contact:a",
      contactId: "contact-a",
      customerId: "customer-a",
      matchKind: "contact_email",
    });

    const attribution = buildSlackAttribution({
      mapping: MAPPING,
      authorEmail: "alice@acme.example",
      authorExternal: true,
      knownParties: aliceInTwoCompanies(),
    });

    expect(attribution.authorContact).toMatchObject({
      contactId: "contact-a",
      customerId: "customer-a",
      customerAccountId: "account-a",
      matchKind: "contact_email",
    });
  });

  it("adds no contact for an internal author even when the email is visible", () => {
    const attribution = buildSlackAttribution({
      mapping: MAPPING,
      authorEmail: "alice@acme.example",
      authorExternal: false,
      knownParties: aliceInTwoCompanies(),
    });

    expect(attribution.authorContact).toBeUndefined();
  });

  it("excludes a resolved authorizing address even without engine metadata", () => {
    const attribution = buildSlackAttribution({
      mapping: MAPPING,
      authorEmail: "me@our-company.example",
      authorExternal: true,
      mailboxEmail: "me@our-company.example",
      knownParties: parties({
        emails: {
          "me@our-company.example": [
            candidate({
              partyKey: "contact:self",
              contactId: "contact-self",
              customerId: "customer-a",
              matchKind: "contact_email",
            }),
          ],
        },
      }),
    });

    expect(attribution.authorContact).toBeUndefined();
  });

  it("passes the member snapshot through, preserving the empty case", () => {
    const members = [
      { slackUserId: "U-alice", name: "Alice", isExternal: true },
    ];

    expect(
      buildSlackAttribution({
        mapping: MAPPING,
        authorExternal: true,
        conversationMembers: members,
      }).conversationMembers
    ).toEqual(members);

    expect(
      buildSlackAttribution({
        mapping: MAPPING,
        authorExternal: true,
        conversationMembers: [],
      }).conversationMembers
    ).toEqual([]);

    expect(
      buildSlackAttribution({
        mapping: MAPPING,
        authorExternal: true,
      }).conversationMembers
    ).toBeUndefined();
  });
});
