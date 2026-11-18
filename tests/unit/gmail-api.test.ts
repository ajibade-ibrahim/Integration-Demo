import { describe, expect, it } from "vitest";

import {
  buildQueryChunks,
  decodeGmailBody,
  decodeHeader,
  gmailDate,
  parseAddressList,
  parseGmailMessage,
} from "@/core/providers/gmail/api";

const OWNER = "owner@our-company.example";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    threadId: "t-1",
    labelIds: ["INBOX"],
    snippet: "A snippet",
    internalDate: String(Date.parse("2026-01-15T10:00:00Z")),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Alice <alice@acme.example>" },
        { name: "To", value: "owner@our-company.example, Bob <bob@acme.example>" },
        { name: "Cc", value: "Carol <carol@acme.example>" },
        { name: "Subject", value: "=?UTF-8?B?SGVsbG8=?=" },
        { name: "Date", value: "Thu, 15 Jan 2026 10:00:00 +0000" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
          body: { data: encoded("Plain body") },
        },
        {
          mimeType: "text/html",
          headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: { data: encoded("<p>HTML body</p>") },
        },
      ],
    },
    ...overrides,
  };
}

describe("Gmail message parsing", () => {
  it("flattens headers, addresses and MIME bodies without losing the HTML source", () => {
    const record = parseGmailMessage(message(), OWNER);

    expect(record).toMatchObject({
      id: "m-1",
      threadId: "t-1",
      fromEmail: "alice@acme.example",
      fromName: "Alice",
      toEmailsCsv: "owner@our-company.example,bob@acme.example",
      ccEmailsCsv: "carol@acme.example",
      subject: "Hello",
      bodyText: "Plain body",
      bodyHtml: "<p>HTML body</p>",
      direction: "received",
    });
    expect(record?.["sentAtIso"]).toBe("2026-01-15T10:00:00.000Z");
  });

  it("drops drafts before mapping", () => {
    expect(
      parseGmailMessage(message({ labelIds: ["DRAFT"] }), OWNER)
    ).toBeUndefined();
  });

  it("parses quoted display names containing commas", () => {
    expect(parseAddressList('"Doe, Jane" <jane@acme.example>, bob@acme.example')).toEqual([
      { email: "jane@acme.example", name: "Doe, Jane" },
      { email: "bob@acme.example" },
    ]);
  });

  it("decodes RFC 2047 and Gmail base64url bodies", () => {
    expect(decodeHeader("=?UTF-8?B?SGVsbG8=?=")).toBe("Hello");
    expect(decodeGmailBody(encoded("Hello"), "text/plain; charset=utf-8")).toBe(
      "Hello"
    );
  });

  it("builds an after-bounded query and chunks long party lists", () => {
    const chunks = buildQueryChunks(
      {
        rawEmails: [
          "alice@acme.example",
          "bob@acme.example",
          "carol@acme.example",
          "dave@acme.example",
        ],
        domains: ["acme.example"],
      },
      new Date("2026-01-15T10:00:00Z")
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("after:2026/01/15");
    expect(chunks.join(" ")).toContain("alice@acme.example");
  });

  it("formats Gmail's date operator in UTC", () => {
    expect(gmailDate(new Date("2026-01-15T23:30:00-05:00"))).toBe("2026/01/16");
  });
});
