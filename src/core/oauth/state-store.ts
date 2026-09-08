/**
 * Short-lived store for issued OAuth state values.
 *
 * State is the CSRF defence for the authorization flow: we hand a random value
 * to the provider and refuse any callback that does not return it. Entries are
 * single-use and expire, so a leaked or replayed callback URL is useless.
 *
 * In-process on purpose — this is a single-node demo. A multi-instance
 * deployment would move this to Redis or a table; the interface is small
 * enough that swapping it is contained.
 */

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

interface StateEntry {
  state: string;
  subject: StateSubject;
  expiresAt: number;
}

/**
 * Held on globalThis rather than as a plain module-level Map.
 *
 * `/start` and `/callback` are separate route modules, and Next re-evaluates
 * modules on hot reload in dev — either can hand the two routes different Map
 * instances, so a state issued by one is invisible to the other and every
 * callback fails validation. Same reasoning as the Prisma client singleton.
 */
const globalForState = globalThis as unknown as {
  oauthStateEntries: Map<string, StateEntry> | undefined;
};

const entries: Map<string, StateEntry> =
  globalForState.oauthStateEntries ?? new Map<string, StateEntry>();

globalForState.oauthStateEntries = entries;

function sweep(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

/** Issue and record a new state value for a draft or an integration. */
export function issueState(subject: StateSubject, now = Date.now()): string {
  sweep(now);
  const state = generateState();
  entries.set(state, {
    state,
    subject,
    expiresAt: now + STATE_TTL_MS,
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
 * failed attempt.
 */
export function consumeState(
  returnedState: string | null,
  now = Date.now()
): StateValidation {
  sweep(now);

  if (returnedState === null || returnedState === "") {
    return { ok: false, reason: "No state parameter was returned" };
  }

  const entry = entries.get(returnedState);
  if (entry === undefined) {
    return { ok: false, reason: "State does not match any pending authorization" };
  }

  entries.delete(returnedState);

  if (entry.expiresAt <= now) {
    return { ok: false, reason: "Authorization request expired" };
  }
  if (!safeEqual(entry.state, returnedState)) {
    return { ok: false, reason: "State mismatch" };
  }

  return { ok: true, subject: entry.subject };
}

/** Drop any pending state for an integration, e.g. when it is deleted. */
export function discardStateFor(integrationId: string): void {
  for (const [key, entry] of entries) {
    if (
      entry.subject.kind === "integration" &&
      entry.subject.integrationId === integrationId
    ) {
      entries.delete(key);
    }
  }
}

/** Drop any pending state for a draft, e.g. once it has been connected. */
export function discardStateForDraft(draftId: string): void {
  for (const [key, entry] of entries) {
    if (entry.subject.kind === "draft" && entry.subject.draftId === draftId) {
      entries.delete(key);
    }
  }
}

/** Test helper. */
export function clearStateStore(): void {
  entries.clear();
}
