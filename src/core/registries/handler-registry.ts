/**
 * Sync handler and field discovery registries, keyed by (function, provider).
 */

import { objectsForFunction } from "../object-schema";
import type { FieldDiscovery, SyncHandler } from "../types/registry";

const handlers = new Map<string, SyncHandler>();
const discoverers = new Map<string, FieldDiscovery>();

function key(functionName: string, providerName: string): string {
  return `${functionName}:${providerName}`;
}

export function registerSyncHandler(
  functionName: string,
  providerName: string,
  handler: SyncHandler
): void {
  const k = key(functionName, providerName);
  if (handlers.has(k)) {
    throw new Error(`HandlerRegistry: '${k}' is already registered`);
  }

  const owned = objectsForFunction(functionName);
  if (handler.objects.length === 0) {
    throw new Error(
      `HandlerRegistry: '${k}' must declare at least one target object`
    );
  }
  const foreign = handler.objects.filter((object) => !owned.includes(object));
  if (foreign.length > 0) {
    throw new Error(
      `HandlerRegistry: '${k}' claims objects the function does not write: ${foreign.join(", ")}`
    );
  }

  handlers.set(k, handler);
}

export function getSyncHandler(
  functionName: string,
  providerName: string
): SyncHandler | undefined {
  return handlers.get(key(functionName, providerName));
}

export function requireSyncHandler(
  functionName: string,
  providerName: string
): SyncHandler {
  const handler = getSyncHandler(functionName, providerName);
  if (handler === undefined) {
    throw new Error(
      `No sync handler registered for function '${functionName}' on provider '${providerName}'`
    );
  }
  return handler;
}

export function registerFieldDiscovery(
  functionName: string,
  providerName: string,
  discovery: FieldDiscovery
): void {
  discoverers.set(key(functionName, providerName), discovery);
}

export function getFieldDiscovery(
  functionName: string,
  providerName: string
): FieldDiscovery | undefined {
  return discoverers.get(key(functionName, providerName));
}

/** Test helper. */
export function clearHandlerRegistries(): void {
  handlers.clear();
  discoverers.clear();
}
