/**
 * Function registry, and the scope resolution that is the point of the whole
 * platform.
 */

import type { FunctionDefinition } from "../types/registry";
import { Registry } from "./registry";

function cloneFunction(d: FunctionDefinition): FunctionDefinition {
  const scopes = new Map<string, readonly string[]>();
  for (const [provider, list] of d.scopesByProvider) scopes.set(provider, [...list]);
  return { ...d, dataModels: [...d.dataModels], scopesByProvider: scopes };
}

export const functionRegistry = new Registry<FunctionDefinition>(
  "FunctionRegistry",
  cloneFunction
);

export function registerFunction(definition: FunctionDefinition): void {
  functionRegistry.register(definition, (d) => {
    if (!(d.scopesByProvider instanceof Map)) {
      throw new Error(
        `FunctionRegistry: '${d.name}' scopesByProvider must be a Map`
      );
    }
    if (!Array.isArray(d.dataModels) || d.dataModels.length === 0) {
      throw new Error(
        `FunctionRegistry: '${d.name}' must declare at least one data model`
      );
    }
  });
}

/**
 * The OAuth scopes to request for a set of functions on one provider.
 *
 * This is the rule the platform exists to enforce: the scopes asked for are
 * the union of those the selected functions declare for that provider, and
 * nothing else. A scope belonging exclusively to some other function can never
 * appear in the result.
 *
 * Takes an array although the UI selects a single function — multi-function
 * integrations then become a UI change rather than a refactor here.
 *
 * @throws If a function is unregistered, or declares no scopes for the provider.
 */
export function resolveScopes(
  functionNames: readonly string[],
  providerName: string
): string[] {
  const resolved = new Set<string>();

  for (const functionName of functionNames) {
    const definition = functionRegistry.require(functionName);
    const scopes = definition.scopesByProvider.get(providerName);

    if (scopes === undefined || scopes.length === 0) {
      throw new Error(
        `Function '${functionName}' is not supported by provider '${providerName}'`
      );
    }
    for (const scope of scopes) resolved.add(scope);
  }

  // Sorted so authorization URLs are stable and comparable in tests.
  return [...resolved].sort();
}

/** Providers that declare support for a function. Empty is a valid answer. */
export function providerNamesForFunction(functionName: string): string[] {
  const definition = functionRegistry.get(functionName);
  if (definition === undefined) return [];
  return [...definition.scopesByProvider.entries()]
    .filter(([, scopes]) => scopes.length > 0)
    .map(([provider]) => provider)
    .sort();
}

/**
 * Providers that can serve *every* one of the given functions.
 *
 * One integration is a single OAuth grant against a single account, so a
 * provider is only a candidate if it covers the whole set — picking identity
 * and support together must not offer a provider that can only do one of them.
 * Selecting no functions yields no providers rather than all of them.
 */
export function providerNamesForFunctions(
  functionNames: readonly string[]
): string[] {
  if (functionNames.length === 0) return [];

  return functionNames
    .map((name) => new Set(providerNamesForFunction(name)))
    .reduce<string[] | undefined>((acc, providers) => {
      if (acc === undefined) return [...providers];
      return acc.filter((p) => providers.has(p));
    }, undefined)
    ?.sort() ?? [];
}

/**
 * Whether a stored grant still covers what the current function set needs.
 *
 * Adding a function to a live integration widens its scope requirement past
 * what the user consented to. Catching that here turns an opaque mid-sync 403
 * into an explicit "reconnect to grant additional access" prompt.
 */
export function scopesAreCovered(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[]
): boolean {
  const granted = new Set(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

/** Required scopes not present in a stored grant. */
export function missingScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[]
): string[] {
  const granted = new Set(grantedScopes);
  return requiredScopes.filter((scope) => !granted.has(scope));
}

/** Functions a given provider can serve. */
export function functionNamesForProvider(providerName: string): string[] {
  return functionRegistry
    .getAll()
    .filter((d) => (d.scopesByProvider.get(providerName)?.length ?? 0) > 0)
    .map((d) => d.name)
    .sort();
}
