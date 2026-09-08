/**
 * Shared provider HTTP client.
 *
 * HubSpot and Salesforce differ in almost everything — pagination, query
 * shape, field naming — but fail in the same four ways, and getting those
 * wrong is what makes a sync flaky rather than broken. So the failure policy
 * lives here once:
 *
 *   401  refresh the token and retry the same request once; a second 401 means
 *        the grant is dead, so stop and ask for re-authorization
 *   429  wait (Retry-After if given, otherwise the configured fallback) and
 *        retry the same request, so pagination resumes at the same cursor
 *        rather than restarting the run
 *   5xx  retryable at the run level — the provider may simply be having a
 *        moment
 *   other  fail the run; everything already written stays written
 *
 * The inline 429 retry is bounded. Beyond that the request gives up and lets
 * the sync engine's run-level retry take over, which is slower but bounded by
 * `SYNC_MAX_ATTEMPTS` rather than by the provider's willingness to keep saying
 * no.
 *
 * No database imports here on purpose: token refresh arrives as a callback on
 * the handler context, which is what lets these paths be tested against msw
 * with no Prisma client in sight.
 */

import { syncTiming, systemClock } from "../sync/clock";
import {
  ProviderHttpError,
  ReauthorizationRequiredError,
  RetryableSyncError,
} from "../sync/errors";
import type { HandlerContext, ProviderMetadata } from "../types/registry";

/** Consecutive rate-limit waits one request will absorb before giving up. */
const MAX_INLINE_RATE_LIMIT_WAITS = 2;

/** Enough of an error body to diagnose from, not enough to flood a log. */
const MAX_BODY_CHARS = 500;

export interface ProviderSession {
  /** GET a JSON document, applying the failure policy above. */
  getJson(url: string): Promise<unknown>;
  /** Current provider metadata; may change if a refresh occurs mid-run. */
  readonly metadata: ProviderMetadata;
}

/** Context a session needs — the credential-bearing subset of HandlerContext. */
export type SessionContext = Omit<HandlerContext, "requestedSourcePaths">;

export interface ProviderSessionOptions {
  /**
   * Headers carrying the credential. Defaults to the OAuth bearer scheme.
   *
   * Called per request rather than once, because a mid-run refresh replaces the
   * credential and the headers have to follow it.
   */
  readonly authHeaders?: (credential: string) => Record<string, string>;

  /**
   * What to call the credential when a 401 cannot be recovered from. Defaults
   * to "refresh token"; an API-key provider should say so, because "no refresh
   * token is available" reads as a misconfiguration when the truth is that the
   * credential kind has no refresh at all.
   */
  readonly credentialNoun?: string;
}

const bearerHeaders = (credential: string): Record<string, string> => ({
  Authorization: `Bearer ${credential}`,
});

/**
 * Parse a Retry-After header, which providers give as either delay-seconds or
 * an HTTP date.
 *
 * @returns Milliseconds to wait, or undefined if the header is absent or
 *   unparseable — the caller then falls back to the configured default.
 */
export function retryAfterMs(
  header: string | null,
  now = Date.now()
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  // delay-seconds
  if (/^\d+$/.test(trimmed)) {
    return clampWait(Number.parseInt(trimmed, 10) * 1000);
  }

  // HTTP-date. Guarded by a letter check because Date.parse is far too
  // willing: it reads "-5" as a year and "7.5" as a date, turning a malformed
  // header into a zero-millisecond wait and a hot retry loop against a provider
  // that just asked us to slow down. Every real HTTP-date carries a month name.
  if (!/[a-zA-Z]/.test(trimmed)) return undefined;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;

  // A date in the past means "retry now", not "travel backwards".
  return clampWait(Math.max(0, at - now));
}

/**
 * Longest we will sit on a single request before handing back to the run-level
 * retry. A provider asking for an hour — or a clock skewed by a day — should
 * not silently park a sync for that long.
 */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

function clampWait(ms: number): number {
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Open a session against a provider API.
 *
 * @param label Provider name, used only to make error messages nameable.
 */
export function createProviderSession(
  ctx: SessionContext,
  label: string,
  options: ProviderSessionOptions = {}
): ProviderSession {
  const clock = ctx.clock ?? systemClock;
  const authHeaders = options.authHeaders ?? bearerHeaders;

  // Mutable because a mid-run refresh replaces both. Salesforce in particular
  // returns its instance_url on every token response, so metadata is not
  // guaranteed stable across a refresh.
  let accessToken = ctx.accessToken;
  let metadata: ProviderMetadata = ctx.metadata;

  async function getJson(url: string): Promise<unknown> {
    let refreshed = false;
    let rateLimitWaits = 0;

    for (;;) {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          ...authHeaders(accessToken),
          Accept: "application/json",
        },
      });

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new ProviderHttpError(
            `${label} returned a non-JSON body`,
            response.status,
            ""
          );
        }
      }

      if (response.status === 401) {
        if (!refreshed && ctx.refreshAccessToken !== undefined) {
          refreshed = true;
          const next = await ctx.refreshAccessToken();
          accessToken = next.accessToken;
          metadata = next.metadata;
          continue;
        }
        throw new ReauthorizationRequiredError(
          refreshed
            ? `${label} rejected the credentials even after a refresh`
            : `${label} rejected the credentials and no ` +
              `${options.credentialNoun ?? "refresh token"} is available`
        );
      }

      if (response.status === 429) {
        const wait =
          retryAfterMs(response.headers.get("retry-after"), clock.now()) ??
          syncTiming().rateLimitFallbackMs;

        if (rateLimitWaits >= MAX_INLINE_RATE_LIMIT_WAITS) {
          // Hand back to the run-level retry rather than waiting indefinitely.
          throw new RetryableSyncError(
            `${label} is still rate limiting after ${MAX_INLINE_RATE_LIMIT_WAITS} waits`,
            wait
          );
        }

        rateLimitWaits += 1;
        await clock.sleep(wait);
        continue;
      }

      const body = await safeBody(response);

      if (response.status >= 500) {
        throw new RetryableSyncError(
          `${label} returned ${response.status}: ${body}`
        );
      }

      throw new ProviderHttpError(
        `${label} returned ${response.status}: ${body}`,
        response.status,
        body
      );
    }
  }

  return {
    getJson,
    get metadata(): ProviderMetadata {
      return metadata;
    },
  };
}

async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_BODY_CHARS);
  } catch {
    return "(unreadable body)";
  }
}

// ---------------------------------------------------------------------------
// Response shape helpers
// ---------------------------------------------------------------------------

/** Narrow an unknown JSON value to a record, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read an array property, tolerating providers that omit it when empty. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a string property, or undefined if absent or the wrong type. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
