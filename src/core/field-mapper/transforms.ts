/**
 * Value transforms applied between reading a source field and writing a target.
 *
 * `domainFromUrl` is the one that earns its place: Salesforce stores
 * `Account.Website` as a full URL while our `domain` target wants a bare host,
 * so without it the default Salesforce mapping produces unusable data.
 */

import type { FieldTransform } from "../types/mapping";

/**
 * Strip scheme, `www.`, port, path and query, leaving a bare lowercase host.
 *
 * Exported because identity resolution needs the same host extraction when it
 * turns a `customer.domain` value into a match key. Two implementations of
 * "the host part of this" would drift, and a drifted matcher silently fails to
 * join records rather than erroring.
 */
export function domainFromUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    // Not URL-shaped; fall back to the raw value rather than losing data.
    return trimmed.toLowerCase();
  }
}

/** Reduce an ISO timestamp to its date portion. */
function dateOnly(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return parsed.toISOString().slice(0, 10);
}

export function applyTransform(
  transform: FieldTransform,
  value: string
): string | null {
  switch (transform) {
    case "none":
      return value;
    case "trim":
      return value.trim();
    case "lowercase":
      return value.toLowerCase();
    case "domainFromUrl":
      return domainFromUrl(value);
    case "dateOnly":
      return dateOnly(value);
  }
}
