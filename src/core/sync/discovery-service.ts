/**
 * Field discovery orchestration: registry lookup, credentials, cache.
 *
 * Mirrors the sync engine's shape — the engine resolves a handler for
 * (function, provider) and hands it a token; this resolves a discoverer the
 * same way. Providers without a registered discoverer are not an error worth
 * failing the mapping editor over, so they yield an empty list and the editor
 * falls back to free-text entry.
 */

import { getFieldDiscovery } from "../registries/handler-registry";
import { canRefresh } from "../registries/provider-registry";
import { getValidToken, refreshToken } from "../oauth/oauth-service";
import { findIntegration } from "../repositories/integration-repository";
import {
  findDiscoveredFields,
  replaceDiscoveredFields,
} from "../repositories/discovered-field-repository";
import { TARGET_OBJECTS, type TargetObject } from "../types/common";
import type { DiscoveredFieldDef } from "../types/registry";
import { systemClock, type Clock } from "./clock";

/** How long cached fields are served before the provider is asked again. */
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface DiscoveryResult {
  object: TargetObject;
  fields: DiscoveredFieldDef[];
  /** True when served from `DiscoveredField` rather than the provider. */
  cached: boolean;
}

export interface DiscoveryOptions {
  clock?: Clock;
  /** Skip the cache and re-read the provider's schema. */
  refresh?: boolean;
}

export async function discoverFields(
  integrationId: string,
  functionName: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult[]> {
  const clock = options.clock ?? systemClock;

  const integration = await findIntegration(integrationId);
  if (integration === undefined) {
    throw new Error("Integration not found");
  }

  const discovery = getFieldDiscovery(functionName, integration.providerName);
  const results: DiscoveryResult[] = [];

  for (const object of TARGET_OBJECTS) {
    if (options.refresh !== true) {
      const cached = await findDiscoveredFields(integrationId, functionName, object);
      const fresh =
        cached.fetchedAt !== null &&
        clock.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS;

      if (fresh && cached.fields.length > 0) {
        results.push({ object, fields: cached.fields, cached: true });
        continue;
      }
    }

    if (discovery === undefined) {
      results.push({ object, fields: [], cached: false });
      continue;
    }

    // Fetched lazily and per-object so a cache hit costs no token work.
    const token = await getValidToken(integrationId, clock.now());
    const fields = await discovery.discover(
      {
        integrationId,
        accessToken: token.accessToken,
        metadata: token.metadata,
        clock,
        // Withheld for credential kinds that cannot refresh — see the same
        // guard in `sync-engine.ts`. Without it, discovery on a revoked API key
        // reports "token refresh failed" in the mapping editor rather than
        // telling the user to re-enter the key.
        ...(canRefresh(integration.providerName)
          ? {
              refreshAccessToken: async () => {
                const refreshed = await refreshToken(integrationId);
                return {
                  accessToken: refreshed.accessToken,
                  metadata: refreshed.metadata,
                };
              },
            }
          : {}),
      },
      object
    );

    await replaceDiscoveredFields(integrationId, functionName, object, fields);
    results.push({ object, fields: [...fields], cached: false });
  }

  return results;
}
