/**
 * Stripe REST specifics: base URL, API version, cursor pagination, and the
 * synthesis of a billing contact from the customer's own fields.
 *
 * Two shapes here are Stripe-specific and carry the risk:
 *
 *   1. Pagination is a cursor built from *our own* returned data
 *      (`starting_after=<id of the last row>`), not an opaque token the server
 *      hands back. So the terminating condition depends on us reading an id
 *      correctly — see `parseCustomersPage`.
 *   2. `created` is Unix epoch seconds, and every date the record writer
 *      accepts goes through `new Date(string)`. `epochToIso` exists so a
 *      mapped create date is not silently dropped.
 *
 * Docs: https://docs.stripe.com/api/customers/list
 */

import type { RawRecord } from "../../types/common";
import { asArray, asRecord, asString } from "../http";

/** Records per page. Stripe's own default is 10; its documented maximum is 100. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Runaway guard.
 *
 * Metrifox needs one because page numbers have no natural end. Stripe's cursor
 * does terminate — but only when the server says `has_more: false`, and the
 * cursor itself is derived from ids we read out of the response. A server
 * emitting fresh ids with `has_more: true` forever would page until the process
 * died, so the bound is on us rather than on its good behaviour.
 */
export const STRIPE_MAX_PAGES = 1000;

/** How many customers discovery samples to find tenant-specific metadata keys. */
export const STRIPE_DISCOVERY_SAMPLE = 25;

/**
 * The API version this provider is written against.
 *
 * Pinned, and pinned overridably, for the same reason as
 * `salesforceApiVersion()`: the response shape this file parses belongs to a
 * version, and letting it follow the *account's* default version means a
 * dashboard setting on someone else's Stripe account decides what our parser
 * receives. Env-overridable is load-bearing in the other direction too — Stripe
 * answers an unrecognised version with a 400, which `createProviderSession`
 * classifies as fatal, so a stale literal here would be an unfixable failed run.
 */
export function stripeApiVersion(): string {
  const version = process.env["STRIPE_API_VERSION"];
  return version === undefined || version === "" ? "2026-08-26.dahlia" : version;
}

/**
 * Base URL for the Stripe API.
 *
 * Overridable so tests and a local `stripe-mock` can point elsewhere, exactly
 * like `metrifoxApiBase()`.
 */
export function stripeApiBase(): string {
  const base = process.env["STRIPE_API_BASE"];
  const resolved = base === undefined || base === "" ? "https://api.stripe.com" : base;

  // The API key travels in a header on every one of these requests. A base that
  // is neither HTTPS nor loopback would put a live credential on the wire in
  // clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(`STRIPE_API_BASE must use https (or localhost); got '${resolved}'`);
  }
  return resolved;
}

export function stripePageSize(): number {
  const raw = process.env["STRIPE_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Headers carrying the credential and the pinned API version.
 *
 * One function rather than two so the connect-time probe and the sync session
 * cannot drift onto different API versions — the probe deliberately bypasses
 * `createProviderSession`, so without this it would be the one request in the
 * system speaking an unpinned version.
 *
 * `Stripe-Version` rides along here because `ProviderSessionOptions` offers no
 * other header hook. Adding a `staticHeaders` option to the shared client for
 * one provider's benefit would be the wrong trade: this is a two-line comment,
 * that would be a new concept in a file every provider depends on.
 */
export function stripeAuthHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": stripeApiVersion(),
  };
}

export function customersUrl(limit: number, startingAfter?: string): string {
  // Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
  // base's own path entirely, which would silently strip any prefix a mock or
  // proxy is mounted under.
  const url = new URL(`${stripeApiBase().replace(/\/$/, "")}/v1/customers`);
  url.searchParams.set("limit", String(limit));
  if (startingAfter !== undefined) {
    url.searchParams.set("starting_after", startingAfter);
  }
  return url.toString();
}

export interface StripePage {
  readonly customers: readonly RawRecord[];
  /** Stripe's own end-of-data signal. */
  readonly hasMore: boolean;
  /**
   * Cursor for the next request: the id of the last usable row on this page,
   * or undefined if this page yielded none. Undefined has to stop the loop even
   * when `hasMore` is true — the alternative is repeating the previous cursor
   * forever.
   */
  readonly lastId: string | undefined;
}

/**
 * Read one customers response.
 *
 * `object === "list"` is deliberately not required. It is present on every real
 * response, but treating it as a gate means a fixture or proxy that omits it
 * yields zero records and a clean, silent, empty sync — a much worse failure
 * than a parse error. `data` and `has_more` are the only fields that matter.
 */
export function parseCustomersPage(json: unknown): StripePage {
  const body = asRecord(json);
  const data = asArray(body?.["data"]);

  const customers = data.filter((row): row is RawRecord => asRecord(row) !== undefined);

  // Scanned backwards, because the cursor must be the last row Stripe returned,
  // not the last one we happened to find an id on.
  let lastId: string | undefined;
  for (let i = customers.length - 1; i >= 0; i -= 1) {
    const id = asString(customers[i]?.["id"]);
    if (id !== undefined) {
      lastId = id;
      break;
    }
  }

  return {
    customers,
    // Strict, because `Boolean("false")` is true and providers do send strings.
    hasMore: body?.["has_more"] === true,
    lastId,
  };
}

// ---------------------------------------------------------------------------
// Synthesized fields
// ---------------------------------------------------------------------------

/**
 * Stripe's `created` (Unix epoch seconds) as an ISO 8601 string.
 *
 * Without this, mapping `created` to `customer.createDate` loses the value
 * silently: the field mapper stringifies the number to "1680893993", and the
 * record writer's date parse is `new Date(value)`, which is an Invalid Date for
 * that input and stores null. No transform rescues it either — `dateOnly`
 * returns its input unchanged when parsing fails. So the conversion has to
 * happen while we still have the number.
 *
 * Takes `unknown` and narrows locally: `asString` returns undefined for a
 * number, and there is no `asNumber` in the shared helpers — adding one for a
 * single caller would widen a file every provider imports.
 */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The stable synthetic id for a customer's billing contact.
 *
 * ALGORITHM v1 — changing this re-keys every existing Stripe contact. `Contact`
 * is unique on `(integrationId, externalSourceId)`, so an id that shifts
 * between runs does not error: it silently inserts a duplicate person and
 * orphans the old row.
 *
 * A *constant* slot, unlike Metrifox's email-derived one. That difference is
 * the point: Metrifox lists several contact people per customer and needs to
 * tell them apart, while Stripe has exactly one contact per customer by
 * construction. Deriving the id from the email here would buy nothing and cost
 * everything — an address correction would re-key the row.
 */
export function stripeContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing-contact record for one Stripe customer.
 *
 * Deliberately not a spread of the customer. Two reasons: `externalIdOf` falls
 * back to `id` for customers, so a contact carrying the customer's `id` would
 * make that fallback ambiguous; and `STRIPE_CONTACT_FIELDS` is a static list,
 * so a spread would put `metadata.*` and every other customer field onto
 * contact records that the mapping editor never offers.
 *
 * @returns The record, or undefined when there is nothing identifying to build
 *   it from. That guard is not cosmetic: `Contact.name` is required, and the
 *   record writer trims before checking, so a customer whose name is blank or
 *   whitespace and whose email is absent would be rejected for "Name is
 *   required" on every sync, forever. Emitting nothing is the honest answer —
 *   Stripe simply has no contact for that customer.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const name = nonEmpty(asString(customer["name"])?.trim());
  const email = nonEmpty(asString(customer["email"])?.trim());

  // Stripe's `name` is whatever the merchant put there — a person for a
  // consumer business, a company for a B2B one. Either way it is the name
  // attached to this billing relationship, so it is the best contact name
  // available. The email local part is the fallback, which is at least
  // recognisable to whoever set the address.
  const contactName = name ?? (email === undefined ? undefined : localPart(email));
  if (contactName === undefined) return undefined;

  return {
    contact_id: stripeContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    phone: asString(customer["phone"])?.trim() ?? null,
    customer_id: customerId,
    customer_name: name ?? null,
  };
}

/** Collapse a blank string to undefined, so "  " and absent behave alike. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  // `at > 0`, not `!== -1`: an address that begins with "@" has no local part,
  // and slicing it would produce the empty name this whole guard exists to
  // avoid.
  return at > 0 ? email.slice(0, at) : email;
}
