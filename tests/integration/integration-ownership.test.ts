/**
 * Ownership scoping: one user's integration is invisible to another.
 *
 * The gap this protects against was real. Every `/api/integrations/[id]/*`
 * route resolved its integration with `findIntegration(id)` — a lookup by
 * primary key with no user in the `where` clause — so with real authentication
 * in place any signed-in caller could read, re-map, sync, delete, or attach a
 * credential to any integration whose id they could name. It was invisible in
 * the demo only because a single seeded user owned everything.
 *
 * These assertions are deliberately negative and phrased against the
 * repository rather than the routes: `findIntegrationForUser` is the single
 * choke point every one of those routes now goes through, so pinning it here
 * covers all of them without standing up ten HTTP handlers. The route wiring
 * is what `grep -rn "findIntegration(" src/app/` guards, and it should stay
 * empty.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createIntegration,
  findIntegration,
  findIntegrationForUser,
} from "@/core/repositories/integration-repository";
import { prisma } from "@/lib/prisma";

let ownerId: string;
let strangerId: string;
let integrationId: string;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `ownership-${randomUUID()}@test.local` },
    select: { id: true },
  });
  return user.id;
}

beforeEach(async () => {
  ownerId = await newUser();
  strangerId = await newUser();

  const integration = await createIntegration({
    userId: ownerId,
    providerName: "metrifox",
    functionNames: ["identity"],
    instanceLabel: "Metrifox — owned",
  });
  integrationId = integration.id;
});

describe("findIntegrationForUser", () => {
  it("returns the integration to its owner", async () => {
    const found = await findIntegrationForUser(integrationId, ownerId);

    expect(found).toBeDefined();
    expect(found?.id).toBe(integrationId);
    expect(found?.userId).toBe(ownerId);
  });

  it("hides another user's integration", async () => {
    expect(await findIntegrationForUser(integrationId, strangerId)).toBeUndefined();
  });

  it("is indistinguishable from a missing integration", async () => {
    // Both cases must produce the same `undefined`, so every caller answers 404
    // to both. A 403 for "exists but not yours" would confirm the id names a
    // real integration, which is precisely what id enumeration is looking for.
    const notYours = await findIntegrationForUser(integrationId, strangerId);
    const notReal = await findIntegrationForUser(randomUUID(), strangerId);

    expect(notYours).toBe(notReal);
  });

  it("does not leak through a valid id paired with a nonexistent user", async () => {
    expect(
      await findIntegrationForUser(integrationId, randomUUID())
    ).toBeUndefined();
  });

  it("still resolves unscoped for the background path", async () => {
    // `findIntegration` deliberately survives: `runScheduledSyncs` sweeps every
    // user's integrations and has no user in scope, so forcing a `userId` on it
    // would mean inventing one. Its safety comes from having no request-scoped
    // callers, not from filtering.
    const found = await findIntegration(integrationId);

    expect(found?.id).toBe(integrationId);
  });
});
