/**
 * Where the "Connect" / "Reconnect" affordance points, per credential kind.
 *
 * One function rather than three inlined ternaries, because the create route
 * and both buttons on the integration detail page have to agree — and a
 * disagreement would send a user to an OAuth route that 400s.
 */

import { providerRegistry } from "../registries/provider-registry";

export function connectHrefFor(
  providerName: string,
  integrationId: string
): string {
  const provider = providerRegistry.get(providerName);
  return provider?.auth.kind === "apiKey"
    ? `/integrations/${integrationId}/connect`
    : `/api/oauth/${providerName}/start?integrationId=${integrationId}`;
}

/**
 * Where a *draft* connects — a first-time attempt, before any row exists.
 *
 * A separate function rather than a flag on the one above, because the two ids
 * are not interchangeable: passing a draft id where an integration id is
 * expected would 404 against the database, and passing an integration id as a
 * draft would silently miss the in-memory store. Distinct URL shapes make that
 * mistake a routing error rather than a confusing empty page.
 */
export function draftConnectHrefFor(
  providerName: string,
  draftId: string
): string {
  const provider = providerRegistry.get(providerName);
  return provider?.auth.kind === "apiKey"
    ? `/integrations/new/connect?draft=${encodeURIComponent(draftId)}`
    : `/api/oauth/${providerName}/start?draftId=${encodeURIComponent(draftId)}`;
}
