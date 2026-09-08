/**
 * Drafts: an integration row exists only once a credential is accepted.
 *
 * The behaviour this protects is the one users noticed the absence of — a
 * rejected key used to leave a row in the list that had to be deleted by hand.
 * The assertions that matter are therefore the negative ones: after a failure,
 * the integration count has not moved.
 *
 * Runs against the throwaway database from `global-setup`, with msw standing in
 * for Metrifox so the probe's verdict is under the test's control.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { bootstrap } from "@/core/bootstrap";
import {
  clearDraftStore,
  createDraft,
  draftCount,
  findDraft,
} from "@/core/integrations/draft-store";
import {
  connectDraftWithApiKey,
  connectWithApiKey,
} from "@/core/credentials/api-key-service";
import { createIntegration } from "@/core/repositories/integration-repository";
import { findToken } from "@/core/repositories/token-repository";
import { countMappings } from "@/core/repositories/mapping-repository";
import { prisma } from "@/lib/prisma";

const CUSTOMERS = "https://api.metrifox.com/api/v1/customers";

const server = setupServer();

beforeAll(() => {
  bootstrap();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

/** Metrifox accepts the key. */
function keyAccepted(): void {
  server.use(
    http.get(CUSTOMERS, () =>
      HttpResponse.json({
        statusCode: 200,
        message: "ok",
        meta: { current_page: 1, next_page: null, total_records: 3 },
        data: [],
      })
    )
  );
}

/** Metrifox rejects the key. */
function keyRejected(): void {
  server.use(
    http.get(CUSTOMERS, () =>
      HttpResponse.json(
        { statusCode: 401, message: "Invalid API key" },
        { status: 401 }
      )
    )
  );
}

/**
 * Integrations belonging to this test's own user.
 *
 * Scoped, never a global count or a global truncate: test files share one
 * SQLite database and vitest runs them in parallel, so counting everything
 * would see rows another file is in the middle of creating.
 */
async function integrationCount(): Promise<number> {
  return prisma.integration.count({ where: { userId } });
}

async function newDraft(userId: string) {
  return createDraft({
    userId,
    providerName: "metrifox",
    functionNames: ["identity"],
    instanceLabel: "Metrifox — drafted",
  });
}

let userId: string;

beforeEach(async () => {
  clearDraftStore();
  // A user of this file's own, so every count below is isolated from whatever
  // other test files are doing to the shared database at the same time.
  const user = await prisma.user.create({
    data: { email: `draft-connect-${randomUUID()}@test.local` },
    select: { id: true },
  });
  userId = user.id;
});

describe("connecting a draft", () => {
  it("creates the integration only once the key is accepted", async () => {
    keyAccepted();
    const draft = await newDraft(userId);

    expect(await integrationCount()).toBe(0);

    const result = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "any-key-shape-now",
    });

    expect(result.ok).toBe(true);
    expect(result.integrationId).toBeDefined();
    expect(await integrationCount()).toBe(1);

    const created = await prisma.integration.findUniqueOrThrow({
      where: { id: result.integrationId ?? "" },
    });
    // Created connected, not pending: there is no window in which a row exists
    // without a credential.
    expect(created.status).toBe("active");
    expect(created.authorizationTimestamp).not.toBeNull();
    expect(created.instanceLabel).toBe("Metrifox — drafted");
  });

  it("stores the credential and seeds mappings, so it can sync immediately", async () => {
    keyAccepted();
    const draft = await newDraft(userId);

    const { integrationId } = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "sk_test_abcd12345678",
    });

    const token = await findToken(integrationId ?? "");
    expect(token).toBeDefined();
    expect(token?.metadata["authKind"]).toBe("apiKey");
    // Non-secret provenance, so a test key in a production integration is
    // noticeable.
    expect(token?.metadata["keyPrefix"]).toBe("sk_test_");

    expect(await countMappings(integrationId ?? "", "identity")).toBeGreaterThan(0);
  });

  it("consumes the draft, so a replayed connect cannot duplicate it", async () => {
    keyAccepted();
    const draft = await newDraft(userId);

    await connectDraftWithApiKey({ draftId: draft.draftId, apiKey: "k1" });
    expect(findDraft(draft.draftId)).toBeUndefined();

    const replay = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "k1",
    });
    expect(replay.ok).toBe(false);
    expect(await integrationCount()).toBe(1);
  });

  // The whole point of the change.
  it("leaves no row behind when the provider rejects the key", async () => {
    keyRejected();
    const draft = await newDraft(userId);

    const result = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "wrong-key",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(await integrationCount()).toBe(0);
  });

  it("leaves no row behind when the key fails the local shape check", async () => {
    // No msw handler: a shape failure must not reach the network at all, and
    // `onUnhandledRequest: "error"` turns a stray request into a failure.
    const draft = await newDraft(userId);

    const result = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "   ",
    });

    expect(result.ok).toBe(false);
    expect(await integrationCount()).toBe(0);
  });

  // Retry is the reason a draft is not consumed on failure. Without this, a
  // typo would cost the user the whole provider/function selection.
  it("keeps the draft after a rejection, so the key can be re-pasted", async () => {
    keyRejected();
    const draft = await newDraft(userId);

    await connectDraftWithApiKey({ draftId: draft.draftId, apiKey: "wrong" });
    expect(findDraft(draft.draftId)).toBeDefined();
    expect(await integrationCount()).toBe(0);

    keyAccepted();
    const retry = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "right",
    });

    expect(retry.ok).toBe(true);
    expect(await integrationCount()).toBe(1);
  });

  it("reports an expired draft rather than creating anything", async () => {
    const result = await connectDraftWithApiKey({
      draftId: "no-such-draft",
      apiKey: "sk_test_abcd12345678",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/i);
    expect(await integrationCount()).toBe(0);
  });

  it("expires drafts on its own, so an abandoned one does not linger", async () => {
    const now = Date.now();
    createDraft(
      {
        userId,
        providerName: "metrifox",
        functionNames: ["identity"],
        instanceLabel: "abandoned",
      },
      now
    );

    expect(draftCount(now)).toBe(1);
    // Just past the 30-minute window.
    expect(draftCount(now + 30 * 60 * 1000 + 1)).toBe(0);
    expect(await integrationCount()).toBe(0);
  });
});

describe("re-keying an integration that already exists", () => {
  it("keeps the row on a rejected key, because it may hold real data", async () => {
    keyRejected();
    const integration = await createIntegration({
      userId,
      providerName: "metrifox",
      functionNames: ["identity"],
      instanceLabel: "Metrifox — established",
    });

    const result = await connectWithApiKey({
      integrationId: integration.id,
      apiKey: "wrong-key",
    });

    expect(result.ok).toBe(false);
    // Deliberately the opposite of the draft path: this row survives and is
    // marked so the user can see why it stopped working.
    expect(await integrationCount()).toBe(1);
    const after = await prisma.integration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(after.status).toBe("error");
  });

  it("connects an existing integration when the key is good", async () => {
    keyAccepted();
    const integration = await createIntegration({
      userId,
      providerName: "metrifox",
      functionNames: ["identity"],
      instanceLabel: "Metrifox — established",
    });

    const result = await connectWithApiKey({
      integrationId: integration.id,
      apiKey: "good-key",
    });

    expect(result.ok).toBe(true);
    expect(await integrationCount()).toBe(1);
    expect(await findToken(integration.id)).toBeDefined();
  });
});
