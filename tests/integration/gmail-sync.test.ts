/**
 * A Gmail communication sync end to end.
 *
 * The provider is driven through msw and the writer through the real database,
 * so this covers the seam the unit tests cannot: known-party loading, matching,
 * streaming page writes, participant replacement, and the complete-pass state.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { prisma } from "@/lib/prisma";
import { bootstrap } from "@/core/bootstrap";
import { executeSync } from "@/core/sync/sync-engine";
import { saveMappings } from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { NON_EXPIRING_AT, saveToken } from "@/core/repositories/token-repository";
import { createFakeClock } from "@/core/sync/clock";

const USER_ID = "user-gmail-sync";
const INTEGRATION_ID = "integration-gmail-sync";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const server = setupServer();

beforeAll(async () => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });

  await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: "gmail-sync@example.test" },
    update: {},
  });
});

afterEach(() => server.resetHandlers());

afterAll(async () => {
  server.close();
  await prisma.user.delete({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.integration.deleteMany({ where: { id: INTEGRATION_ID } });
});

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const MESSAGE = {
  id: "gmail-message-1",
  threadId: "thread-1",
  labelIds: ["INBOX"],
  snippet: "Hello from Acme",
  internalDate: String(Date.parse("2026-01-15T10:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Alice <alice@acme.example>" },
      { name: "To", value: "owner@our-company.example" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Thu, 15 Jan 2026 10:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        body: { data: encoded("Hello from Acme") },
      },
      {
        mimeType: "text/html",
        headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: { data: encoded("<p>Hello from Acme</p>") },
      },
    ],
  },
};

async function connect(): Promise<void> {
  await prisma.integration.create({
    data: {
      id: INTEGRATION_ID,
      userId: USER_ID,
      providerName: "gmail",
      status: "active",
      instanceLabel: "Gmail",
      functions: { create: [{ functionName: "communication" }] },
    },
  });

  await saveToken({
    integrationId: INTEGRATION_ID,
    accessToken: "fake-google-token",
    expiresAt: NON_EXPIRING_AT,
    grantedScopes: [],
    metadata: { email: "owner@our-company.example" },
  });

  await saveMappings(
    INTEGRATION_ID,
    "communication",
    defaultMappingsFor("communication", "gmail")
  );
}

async function seedParty(): Promise<void> {
  const customer = await prisma.customer.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "acme",
      name: "Acme",
      email: "alice@acme.example",
      domain: "acme.example",
    },
    select: { id: true },
  });

  await prisma.contact.create({
    data: {
      integrationId: INTEGRATION_ID,
      externalSourceId: "alice",
      name: "Alice",
      email: "alice@acme.example",
      customerId: customer.id,
    },
  });
}

describe("a Gmail communication sync", () => {
  it("writes a matched message, its participant, and the complete-pass state", async () => {
    await connect();
    await seedParty();

    server.use(
      http.get(`${GMAIL}/messages`, ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        expect(q).toContain("alice@acme.example");
        return HttpResponse.json({ messages: [{ id: MESSAGE.id }] });
      }),
      http.get(`${GMAIL}/messages/${MESSAGE.id}`, () =>
        HttpResponse.json(MESSAGE)
      )
    );

    const result = await executeSync(INTEGRATION_ID, {
      trigger: "manual",
      clock: createFakeClock(Date.parse("2026-02-01T12:00:00Z")),
    });

    expect(result.status).toBe("success");
    expect(result.recordCounts.emailMessage).toBe(1);

    const message = await prisma.emailMessage.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID },
      include: { participants: true },
    });
    expect(message.subject).toBe("Hello");
    expect(message.fromEmail).toBe("alice@acme.example");
    expect(message.direction).toBe("received");
    expect(message.bodyText).toBe("Hello from Acme");
    expect(message.bodyHtml).toBe("<p>Hello from Acme</p>");
    expect(JSON.parse(message.toEmails)).toEqual([
      "owner@our-company.example",
    ]);
    expect(message.participants).toHaveLength(2);
    const primary = message.participants.find((row) => row.isPrimary);
    expect(primary).toMatchObject({
      role: "from",
      matchKind: "contact_email",
      isPrimary: true,
      disputed: false,
    });
    expect(primary?.contactId).not.toBeNull();
    expect(
      message.participants.filter((row) => row.isPrimary)
    ).toHaveLength(1);

    const state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).not.toBeNull();
    expect(state.syncFingerprint).not.toBeNull();
  });

  it("does not call Gmail at all when there are no known parties", async () => {
    await connect();

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(Date.parse("2026-02-01T12:00:00Z")),
    });

    expect(result.status).toBe("success");
    expect(result.coverage.functions[0]?.skippedReason).toBe("no known parties");
    const state = await prisma.integrationFunction.findFirstOrThrow({
      where: { integrationId: INTEGRATION_ID, functionName: "communication" },
    });
    expect(state.lastCompleteSyncAt).toBeNull();
    expect(state.syncFingerprint).toBeNull();
  });

  it("uses an incremental overlap window after a complete pass", async () => {
    await connect();
    await seedParty();

    const queries: string[] = [];
    server.use(
      http.get(`${GMAIL}/messages`, ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q !== null) queries.push(q);
        return HttpResponse.json({ messages: [{ id: MESSAGE.id }] });
      }),
      http.get(`${GMAIL}/messages/${MESSAGE.id}`, () =>
        HttpResponse.json(MESSAGE)
      )
    );

    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(Date.parse("2026-02-01T12:00:00Z")),
    });
    await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(Date.parse("2026-02-03T12:00:00Z")),
    });

    expect(queries[0]).toContain("after:2025/02/01");
    expect(queries[1]).toContain("after:2026/01/30");
  });

  it("does not write a message with no known party", async () => {
    await connect();
    await prisma.customer.create({
      data: {
        integrationId: INTEGRATION_ID,
        externalSourceId: "other",
        name: "Other",
        email: "other@unrelated.example",
      },
    });

    server.use(
      http.get(`${GMAIL}/messages`, () =>
        HttpResponse.json({ messages: [{ id: MESSAGE.id }] })
      ),
      http.get(`${GMAIL}/messages/${MESSAGE.id}`, () =>
        HttpResponse.json(MESSAGE)
      )
    );

    const result = await executeSync(INTEGRATION_ID, {
      clock: createFakeClock(Date.parse("2026-02-01T12:00:00Z")),
    });

    expect(result.status).toBe("success");
    expect(result.recordCounts.emailMessage).toBe(0);
    expect(
      await prisma.emailMessage.count({ where: { integrationId: INTEGRATION_ID } })
    ).toBe(0);
  });
});
