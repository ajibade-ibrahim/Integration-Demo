/**
 * What a provider can actually sync.
 *
 * The function registry declares scopes, not implementations. A scope entry is
 * a claim that a provider *could* serve a function; this module answers the
 * stricter question the picker, the connect API and the integration page need:
 * is there a registered handler, does it declare any target objects, and does
 * the provider still have scopes for the pair?
 *
 * Keeping this separate from `functionRegistry` matters. Scope declarations are
 * used for consent and for the API-key grant record, where "every scope this
 * provider can offer" is the truthful answer. Capability is narrower: an
 * unbuilt function may still be declared for the roadmap, but it must not be
 * offered as something a user can connect.
 */

import {
  functionRegistry,
  resolveScopes,
} from "./registries/function-registry";
import { getSyncHandler } from "./registries/handler-registry";
import { providerRegistry } from "./registries/provider-registry";
import type { TargetObject } from "./types/common";

/** Objects a registered handler can actually produce for this pair. */
export function supportedObjectsFor(
  functionName: string,
  providerName: string
): readonly TargetObject[] {
  return getSyncHandler(functionName, providerName)?.objects ?? [];
}

/**
 * Whether a provider/function pair can be connected and synced today.
 *
 * Requires all three facts, not just a handler: a registered handler with no
 * objects would report success and then write nothing, and a pair with no
 * scopes cannot reach the provider's consent/key flow at all.
 */
export function canSyncFunction(
  functionName: string,
  providerName: string
): boolean {
  if (supportedObjectsFor(functionName, providerName).length === 0) return false;
  if (providerRegistry.get(providerName) === undefined) return false;

  try {
    return resolveScopes([functionName], providerName).length > 0;
  } catch {
    return false;
  }
}

/** Selected functions this provider cannot sync, in the caller's order. */
export function unsupportedFunctionsFor(
  functionNames: readonly string[],
  providerName: string
): string[] {
  return [...new Set(functionNames)].filter(
    (functionName) => !canSyncFunction(functionName, providerName)
  );
}

/** Providers whose handler and scopes can serve one function. */
export function syncableProviderNamesForFunction(
  functionName: string
): string[] {
  const definition = functionRegistry.get(functionName);
  if (definition === undefined) return [];

  return [...definition.scopesByProvider.keys()]
    .filter((providerName) => canSyncFunction(functionName, providerName))
    .sort();
}

/**
 * Providers that can sync *every* selected function.
 *
 * This is the capability counterpart of `providerNamesForFunctions` in
 * `function-registry`: the latter answers "which providers declare all these
 * scopes", which is useful for scope-union tests, while this one answers the
 * question the picker and connect API must ask.
 */
export function syncableProviderNamesForFunctions(
  functionNames: readonly string[]
): string[] {
  if (functionNames.length === 0) return [];

  return providerRegistry
    .getAll()
    .map((provider) => provider.name)
    .filter((providerName) =>
      functionNames.every((functionName) =>
        canSyncFunction(functionName, providerName)
      )
    )
    .sort();
}
