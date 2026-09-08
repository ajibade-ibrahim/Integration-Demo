/**
 * Short-lived store for issued OAuth state values.
 *
 * State is the CSRF defence for the authorization flow: we hand a random value
 * to the provider and refuse any callback that does not return it. Entries are
 * single-use and expire, so a leaked or replayed callback URL is useless.
 *
 * Backed by a table rather than a Map on `globalThis`, for the reason set out in
 * `draft-store.ts`: `/start` issues the state and `/callback` consumes it, and
 * those are two separate requests. On a multi-instance host they need not reach
 * the same instance, and an in-process entry is invisible to every instance but
 * the one that wrote it — so the callback fails state validation and the connect
 * dies at the last step, having already sent the user to the provider.
 *
 * The single-use guarantee survives the move intact, and arguably improves: the
 * read *is* a delete, so two concurrent callbacks bearing the same state race on
 * one row and exactly one of them wins.
 */

import { prisma } from "@/lib/prisma";
import { generateState, safeEqual } from "./crypto";

/** Matches the 30-minute pending-authorization window. */
const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * What a state value was issued on behalf of.
 *
 * A first-time connect authorizes a *draft* — there is no integration row yet,
 * because one is only created once a credential is proven. A reconnect
 * authorizes an existing integration. The callback has to tell these apart to
 * know whether to create a row or update one, and a discriminated union makes
 * that a compile-time obligation rather than a pair of optional fields where
 * both could plausibly be missing.
 */
export type StateSubject =
  | { readonly kind: "integration"; readonly integrationId: string }
  | { readonly kind: "draft"; readonly draftId: string };

/** The union, flattened for storage. `subjectId` means whichever the kind says. */
function toColumns(subject: StateSubject): {
  subjectKind: string;
  subjectId: string;
} {
  return subject.kind === "draft"
    ? { subjectKind: "draft", subjectId: subject.draftId }
    : { subjectKind: "integration", subjectId: subject.integrationId };
}

/**
 * Read the union back.
 *
 * Anything other than the two known discriminants is treated as an integration
 * — the same row shape an older schema would have written, and the branch that
 * fails safely: it looks for an integration that will not be found, rather than
 * creating one from a draft id.
 */
function toSubject(row: { subjectKind: string; subjectId: string }): StateSubject {
  return row.subjectKind === "draft"
    ? { kind: "draft", draftId: row.subjectId }
    : { kind: "integration", integrationId: row.subjectId };
}

/**
 * Delete state values that have already expired.
 *
 * On the issue path only. `consumeState` deletes the row it reads whatever its
 * age, so an expired entry is rejected on sight rather than left to a sweep.
 */
async function sweep(now: number): Promise<void> {
  await prisma.oAuthState.deleteMany({
    where: { expiresAt: { lte: new Date(now) } },
  });
}

/** Issue and record a new state value for a draft or an integration. */
export async function issueState(
  subject: StateSubject,
  now = Date.now()
): Promise<string> {
  await sweep(now);

  const state = generateState();
  await prisma.oAuthState.create({
    data: {
      state,
      ...toColumns(subject),
      expiresAt: new Date(now + STATE_TTL_MS),
    },
  });

  return state;
}

export interface StateValidation {
  ok: boolean;
  subject?: StateSubject;
  reason?: string;
}

/**
 * Validate and consume a returned state value.
 *
 * Consumed whether or not it matches, so a state cannot be replayed after a
 * failed attempt. The delete is what does the consuming, and it is also the
 * existence check: a row that is not there cannot be deleted, and one that is
 * can be deleted exactly once.
 */
export async function consumeState(
  returnedState: string | null,
  now = Date.now()
): Promise<StateValidation> {
  if (returnedState === null || returnedState === "") {
    return { ok: false, reason: "No state parameter was returned" };
  }

  /*
   * P2025 is "record not found", the ordinary answer for a fabricated or
   * already-used state, so it becomes a verdict rather than a throw.
   *
   * Narrowed to that one code deliberately. A bare `catch` here would report an
   * unreachable database as a state mismatch — the user would be told their
   * authorization did not match, and the logs would show a clean rejection
   * instead of an outage. Anything else propagates.
   */
  let entry;
  try {
    entry = await prisma.oAuthState.delete({ where: { state: returnedState } });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2025") throw error;
    return { ok: false, reason: "State does not match any pending authorization" };
  }

  if (entry.expiresAt.getTime() <= now) {
    return { ok: false, reason: "Authorization request expired" };
  }
  // Structurally true — the row was found by primary key — and kept because it
  // is the assertion the flow depends on, so it should be visible where it is
  // relied upon rather than inferred from the query above.
  if (!safeEqual(entry.state, returnedState)) {
    return { ok: false, reason: "State mismatch" };
  }

  return { ok: true, subject: toSubject(entry) };
}

/** Drop any pending state for an integration, e.g. when it is deleted. */
export async function discardStateFor(integrationId: string): Promise<void> {
  await prisma.oAuthState.deleteMany({
    where: { subjectKind: "integration", subjectId: integrationId },
  });
}

/** Drop any pending state for a draft, e.g. once it has been connected. */
export async function discardStateForDraft(draftId: string): Promise<void> {
  await prisma.oAuthState.deleteMany({
    where: { subjectKind: "draft", subjectId: draftId },
  });
}

/** Test helper. */
export async function clearStateStore(): Promise<void> {
  await prisma.oAuthState.deleteMany({});
}
