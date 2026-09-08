/**
 * Short-lived store for integrations that have been configured but not yet
 * connected.
 *
 * The reason this exists: an integration row used to be inserted the moment the
 * user picked a provider and functions, then connected afterwards. Every failed
 * or abandoned connect therefore left a row in the list that the user had to
 * delete by hand. Holding the configuration here instead means nothing is
 * persisted until a credential has actually been proven — `Integration` rows
 * are created connected, and a rejected key leaves no trace.
 *
 * Deliberately *not* the OAuth state store, though it is shaped like one. State
 * is single-use CSRF defence, consumed on every callback whether it succeeded or
 * not. A draft has to survive a failed attempt so the user can re-paste a
 * mistyped key without re-picking provider and functions — so it is consumed
 * only on success, and otherwise left to expire.
 *
 * Backed by a table rather than a Map on `globalThis`. Three separate requests
 * touch one draft — the create call, the connect page render, and the credential
 * submit — and on a multi-instance host each can be served by a different
 * instance, or by one that has since gone cold. An in-process draft is invisible
 * to every request but the one that wrote it, which does not fail intermittently
 * so much as always: the user lands on "this connection attempt expired" holding
 * a draft id that was valid a second ago. A row is visible to all of them, and
 * survives a restart into the bargain.
 */

import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { readJsonArray, writeJsonArray } from "../repositories/json-column";

/**
 * Matches the OAuth state TTL and the pending-authorization window. A draft
 * outliving the state issued from it would offer a Connect button whose
 * callback is guaranteed to fail validation.
 */
const DRAFT_TTL_MS = 30 * 60 * 1000;

export interface IntegrationDraft {
  readonly draftId: string;
  readonly userId: string;
  readonly providerName: string;
  readonly functionNames: readonly string[];
  readonly instanceLabel: string;
  readonly expiresAt: number;
}

/** Row shape as stored, mapped to the interface the rest of the app uses. */
function toDraft(row: {
  id: string;
  userId: string;
  providerName: string;
  functionNames: string;
  instanceLabel: string;
  expiresAt: Date;
}): IntegrationDraft {
  return {
    draftId: row.id,
    userId: row.userId,
    providerName: row.providerName,
    functionNames: readJsonArray<string>(row.functionNames),
    instanceLabel: row.instanceLabel,
    expiresAt: row.expiresAt.getTime(),
  };
}

/**
 * Delete drafts that have already expired.
 *
 * Called from the write paths only. Reads exclude expired rows in their `where`
 * clause instead, which is the same answer for one fewer round trip — an expired
 * draft that lingers a while is invisible, not live.
 */
async function sweep(now: number): Promise<void> {
  await prisma.integrationDraft.deleteMany({
    where: { expiresAt: { lte: new Date(now) } },
  });
}

export interface CreateDraftInput {
  userId: string;
  providerName: string;
  functionNames: readonly string[];
  instanceLabel: string;
}

/**
 * Record a configured-but-unconnected integration.
 *
 * @throws If no function is given. `createIntegration` rejects the same case,
 *   and catching it here means an unusable draft cannot be handed a connect URL
 *   that is certain to fail at the far end.
 * @throws If `userId` names no user. That is the foreign key, not a check of
 *   our own, and it is the earliest point at which a session outliving its user
 *   row is caught — previously such a session got a draft and failed later, at
 *   the insert that the connect attempt made.
 */
export async function createDraft(
  input: CreateDraftInput,
  now = Date.now()
): Promise<IntegrationDraft> {
  await sweep(now);

  const functionNames = [...new Set(input.functionNames)].sort();
  if (functionNames.length === 0) {
    throw new Error("An integration must serve at least one function");
  }

  const row = await prisma.integrationDraft.create({
    data: {
      // Unguessable rather than sequential: a draft id is the handle used to
      // attach a credential, so it should not be enumerable.
      id: randomBytes(24).toString("base64url"),
      userId: input.userId,
      providerName: input.providerName,
      functionNames: writeJsonArray(functionNames),
      instanceLabel: input.instanceLabel,
      expiresAt: new Date(now + DRAFT_TTL_MS),
    },
  });

  return toDraft(row);
}

/**
 * Read a draft without consuming it.
 *
 * Used for rendering the connect page and for every connect attempt, so a
 * rejected credential can be retried against the same draft.
 */
export async function findDraft(
  draftId: string | null,
  now = Date.now()
): Promise<IntegrationDraft | undefined> {
  if (draftId === null || draftId === "") return undefined;

  const row = await prisma.integrationDraft.findFirst({
    where: { id: draftId, expiresAt: { gt: new Date(now) } },
  });

  return row === null ? undefined : toDraft(row);
}

/**
 * Remove a draft, once the integration it describes has actually been created.
 *
 * Separate from {@link findDraft} so the consume happens after the row exists,
 * not before: dropping it first would leave a successful connect with no way to
 * report which integration it produced if the insert then failed.
 *
 * `deleteMany` rather than `delete` because a draft already swept for age is a
 * normal outcome here, not an error worth throwing over.
 */
export async function discardDraft(draftId: string): Promise<void> {
  await prisma.integrationDraft.deleteMany({ where: { id: draftId } });
}

/**
 * Test helper — drop drafts, scoped to one user where a userId is given.
 *
 * Scopeable rather than a plain truncate, because the store is now shared: test
 * files run in parallel against a single schema, so clearing everything would
 * delete drafts another file is in the middle of using.
 */
export async function clearDraftStore(userId?: string): Promise<void> {
  await prisma.integrationDraft.deleteMany({
    where: userId === undefined ? {} : { userId },
  });
}

/** Test helper — how many drafts are live at `now`, for one user where given. */
export async function draftCount(
  now = Date.now(),
  userId?: string
): Promise<number> {
  return prisma.integrationDraft.count({
    where: {
      expiresAt: { gt: new Date(now) },
      ...(userId === undefined ? {} : { userId }),
    },
  });
}
