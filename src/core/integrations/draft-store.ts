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
 * In-process, for the same reason as the state store: this is a single-node
 * demo. Multi-instance would move it to Redis or a table, and the interface is
 * small enough that swapping it is contained. The cost of in-process is worth
 * stating plainly — a server restart drops every open draft, so a user
 * mid-connect gets "this draft has expired" and starts over. That is annoying
 * but safe; the alternative is the row-per-attempt litter this replaces.
 */

import { randomBytes } from "node:crypto";

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

/**
 * Held on globalThis rather than as a module-level Map, for the reason spelled
 * out in `state-store.ts`: the create route, the connect page, and the callback
 * are separate route modules, and Next re-evaluates modules on hot reload in
 * dev. A plain Map can leave them holding different instances, so a draft
 * written by one is invisible to the others.
 */
const globalForDrafts = globalThis as unknown as {
  integrationDrafts: Map<string, IntegrationDraft> | undefined;
};

const drafts: Map<string, IntegrationDraft> =
  globalForDrafts.integrationDrafts ?? new Map<string, IntegrationDraft>();

globalForDrafts.integrationDrafts = drafts;

function sweep(now: number): void {
  for (const [key, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(key);
  }
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
 */
export function createDraft(
  input: CreateDraftInput,
  now = Date.now()
): IntegrationDraft {
  sweep(now);

  const functionNames = [...new Set(input.functionNames)].sort();
  if (functionNames.length === 0) {
    throw new Error("An integration must serve at least one function");
  }

  const draft: IntegrationDraft = {
    // Unguessable rather than sequential: a draft id is the handle used to
    // attach a credential, so it should not be enumerable.
    draftId: randomBytes(24).toString("base64url"),
    userId: input.userId,
    providerName: input.providerName,
    functionNames,
    instanceLabel: input.instanceLabel,
    expiresAt: now + DRAFT_TTL_MS,
  };

  drafts.set(draft.draftId, draft);
  return draft;
}

/**
 * Read a draft without consuming it.
 *
 * Used for rendering the connect page and for every connect attempt, so a
 * rejected credential can be retried against the same draft.
 */
export function findDraft(
  draftId: string | null,
  now = Date.now()
): IntegrationDraft | undefined {
  sweep(now);
  if (draftId === null || draftId === "") return undefined;
  return drafts.get(draftId);
}

/**
 * Remove a draft, once the integration it describes has actually been created.
 *
 * Separate from {@link findDraft} so the consume happens after the row exists,
 * not before: dropping it first would leave a successful connect with no way to
 * report which integration it produced if the insert then failed.
 */
export function discardDraft(draftId: string): void {
  drafts.delete(draftId);
}

/** Test helper. */
export function clearDraftStore(): void {
  drafts.clear();
}

/** Test helper — how many drafts are currently held. */
export function draftCount(now = Date.now()): number {
  sweep(now);
  return drafts.size;
}
