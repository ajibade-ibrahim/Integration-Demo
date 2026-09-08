/**
 * Credential errors.
 *
 * Dependency-free on purpose, like `sync/errors.ts`: provider definitions throw
 * these from their probe, and the connect service catches them. Putting them in
 * the service instead would make every provider import the service, and the
 * service already imports the provider registry — a cycle.
 */

/**
 * A key the provider itself rejected, as opposed to a network hiccup.
 *
 * The distinction decides whether the user is told to fix the key or to try
 * again, which is the difference between actionable and baffling.
 */
export class InvalidApiKeyError extends Error {
  constructor(message = "The provider rejected the API key") {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}
