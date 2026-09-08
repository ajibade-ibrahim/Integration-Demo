/**
 * Sync error taxonomy.
 *
 * Lives apart from the sync engine so provider code can throw these without
 * importing the engine — and, through it, the Prisma client. Provider handlers
 * stay unit-testable against msw with no database in the picture.
 *
 * The distinction that matters is what the caller should do next:
 *   - `RetryableSyncError`      wait and try the whole run again
 *   - `ReauthorizationRequired` stop; no amount of retrying fixes a dead grant
 *   - anything else             fail the run, keep what was already written
 */

/** Errors worth another attempt; anything else fails immediately. */
export class RetryableSyncError extends Error {
  constructor(
    message: string,
    /** Honour a provider's Retry-After rather than our own backoff. */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RetryableSyncError";
  }
}

/**
 * The stored grant is no longer usable — a 401 that survived a token refresh.
 *
 * Deliberately not retryable: the credentials are dead until a human
 * re-authorizes, so retrying only delays telling them so. The sync engine
 * translates this into `requires_reauthorization` on the integration.
 */
export class ReauthorizationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

/** A provider responded with an error status we do not otherwise special-case. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Truncated response body; providers put the useful detail here. */
    readonly body: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}
