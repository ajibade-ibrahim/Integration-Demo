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
  createIntegrationFromDraft,
  finalizeConnection,
} from "@/core/integrations/connection";
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
 * database schema and vitest runs them in parallel, so counting everything
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
  // A user of this file's own, so every count below is isolated from whatever
  // other test files are doing to the shared database at the same time.
  const user = await prisma.user.create({
    data: { email: `draft-connect-${randomUUID()}@test.local` },
    select: { id: true },
  });
  userId = user.id;
});

// Scoped to this file's own user: the draft store is a shared table now, and
// vitest runs test files in parallel, so a blanket clear would delete drafts
// another file is relying on.
afterEach(async () => {
  await clearDraftStore(userId);
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
    expect(await findDraft(draft.draftId)).toBeUndefined();

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
    expect(await findDraft(draft.draftId)).toBeDefined();
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
    await createDraft(
      {
        userId,
        providerName: "metrifox",
        functionNames: ["identity"],
        instanceLabel: "abandoned",
      },
      now
    );

    expect(await draftCount(now, userId)).toBe(1);
    // Just past the 30-minute window.
    expect(await draftCount(now + 30 * 60 * 1000 + 1, userId)).toBe(0);
    expect(await integrationCount()).toBe(0);
  });

  it("refuses to create a pair with no sync handler", async () => {
    // Salesforce declares agreement scopes but has no agreement handler. The
    // route rejects this before a draft exists; this pins the shared connection
    // guard as the second line of defence.
    const draft = await createDraft({
      userId,
      providerName: "salesforce",
      functionNames: ["agreement"],
      instanceLabel: "Salesforce — unsupported",
    });

    let storedCredential = false;
    await expect(
      createIntegrationFromDraft({
        draft,
        at: new Date(),
        storeCredential: async () => {
          storedCredential = true;
        },
      })
    ).rejects.toThrow(/cannot sync agreement/i);

    expect(storedCredential).toBe(false);
    expect(await integrationCount()).toBe(0);
  });

  it("rejects an unsupported draft before probing the key", async () => {
    // No msw handler here: the guard must return before any network call, and
    // `onUnhandledRequest: "error"` would surface one.
    const draft = await createDraft({
      userId,
      providerName: "stigg",
      functionNames: ["support"],
      instanceLabel: "Stigg — unsupported key flow",
    });

    const result = await connectDraftWithApiKey({
      draftId: draft.draftId,
      apiKey: "any-key",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot sync support/i);
    expect(await integrationCount()).toBe(0);
  });

  it("refuses to finalize a legacy integration whose functions have no handler", async () => {
    const integration = await createIntegration({
      userId,
      providerName: "salesforce",
      functionNames: ["agreement"],
      instanceLabel: "Salesforce — legacy",
    });

    await expect(
      finalizeConnection(integration, new Date())
    ).rejects.toThrow(/cannot sync agreement/i);

    const after = await prisma.integration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(after.status).toBe("pending_authorization");
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
