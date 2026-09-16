/**
 * HubSpot API surface shared by the sync handler and field discovery.
 */

import { isIdentityObject } from "../../identity-schema";
import type { TargetObject } from "../../types/common";

/** Overridable so tests can point the client at a local msw server. */
export function hubspotApiBase(): string {
  const base = process.env["HUBSPOT_API_BASE"];
  return base === undefined || base === "" ? "https://api.hubapi.com" : base;
}

/**
 * Records per page. HubSpot caps object reads at 100; the env override exists
 * so tests can force multi-page responses out of small fixtures.
 */
export function hubspotPageSize(): number {
  const raw = process.env["HUBSPOT_PAGE_SIZE"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 100;
}

/** Our target objects expressed as HubSpot's object type names. */
export const HUBSPOT_OBJECT_PATH = {
  customer: "companies",
  contact: "contacts",
} as const;

/**
 * The HubSpot object name for one of our target objects.
 *
 * Throws rather than returning undefined for an object this handler does not
 * serve. That case is a registration mistake — the sync engine and the
 * discovery service both iterate the objects the *function* declares, so
 * `identity` can only ever hand these two down — and a thrown error names it at
 * once, where a silently undefined path would build a URL ending in
 * "/undefined" and report a 404 from HubSpot instead.
 */
export function hubspotObjectPath(object: TargetObject): string {
  if (!isIdentityObject(object)) {
    throw new Error(`HubSpot's identity handler does not serve '${object}'`);
  }
  return HUBSPOT_OBJECT_PATH[object];
}

/**
 * HubSpot property names are lowercase alphanumerics and underscores.
 * Anything else is a user typing something into the mapping editor that
 * HubSpot will reject, so drop it rather than sending a request we know fails.
 */
const PROPERTY_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Turn mapped source paths into the `properties` query parameter.
 *
 * Mapped paths look like `properties.domain`; HubSpot wants a bare comma list
 * of property names, and only returns properties you name, so this is what
 * decides whether a mapped field arrives at all.
 */
export function propertiesParam(
  sourcePaths: readonly string[]
): string[] {
  const names = new Set<string>();
  for (const path of sourcePaths) {
    if (!path.startsWith("properties.")) continue;
    const name = path.slice("properties.".length);
    // Nested paths under a property are not a thing in HubSpot's flat
    // property bag, so a dotted remainder is a mapping mistake.
    if (PROPERTY_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}
