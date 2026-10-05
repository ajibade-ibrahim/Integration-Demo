/**
 * Stigg REST specifics: base URL, opaque-cursor pagination, and the synthesis
 * of a billing contact from the customer's own fields.
 *
 * Two shapes here carry the risk:
 *
 *   1. Pagination. Stigg hands back an opaque `pagination.next` cursor rather
 *      than deriving one from ids, which makes termination the server's signal
 *      — but the docs' "REST Overview" page describes a different contract
 *      (`starting_after`/`has_more`/`next_cursor`) from the OpenAPI spec and
 *      generated SDKs (`after` + `pagination.next`). The OpenAPI shape is taken
 *      as authoritative and parsing is isolated here so a live-key correction
 *      is one function plus the msw handlers.
 *   2. There is no contact resource at all, so like Stripe the contact is
 *      *constructed* from the customer's own `name`/`email` rather than read
 *      from the payload.
 *
 * Docs: https://docs.stigg.io/api
 */

import type { RawRecord } from "../../types/common";
import { asArray, asRecord, asString } from "../http";

/** Records per page. Stigg's own default is 20; its documented maximum is 100. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Runaway guard.
 *
 * `pagination.next` terminates, but it is an opaque value the server issues and
 * a server that kept minting fresh cursors would page until the process died.
 * The bound is on us rather than on its good behaviour, as Metrifox's and
 * Stripe's are.
 */
export const STIGG_MAX_PAGES = 1000;

/** How many customers discovery samples to find environment-specific metadata keys. */
export const STIGG_DISCOVERY_SAMPLE = 25;

/**
 * Base URL for the Stigg API.
 *
 * Overridable so tests and a local mock can point elsewhere, exactly like
 * `metrifoxApiBase()`.
 */
export function stiggApiBase(): string {
  const base = process.env["STIGG_API_BASE"];
  const resolved =
    base === undefined || base === "" ? "https://api.stigg.io" : base;

  // The API key travels in a header on every one of these requests. A base
  // that is neither HTTPS nor loopback would put a live credential on the
  // wire in clear, so refuse rather than quietly doing it.
  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(
      `STIGG_API_BASE must use https (or localhost); got '${resolved}'`,
    );
  }
  return resolved;
}

export function stiggPageSize(): number {
  const raw = process.env["STIGG_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * The customers list URL, with Stigg's cursor parameters applied.
 *
 * Concatenated, not `new URL(path, base)`: a leading-slash path replaces the
 * base's own path entirely, which would silently strip any prefix a mock or
 * proxy is mounted under.
 */
export function customersUrl(limit: number, after?: string): string {
  const url = new URL(
    `${stiggApiBase().replace(/\/$/, "")}/api/v1/customers`,
  );
  url.searchParams.set("limit", String(limit));
  // The cursor is echoed verbatim, never constructed: it is opaque and
  // server-owned, unlike Stripe's id-derived `starting_after`.
  if (after !== undefined) url.searchParams.set("after", after);
  return url.toString();
}

export interface StiggPage {
  readonly records: readonly RawRecord[];
  /**
   * Cursor for the next request, or undefined on the last page. Trusted over
   * any count field because it is what the API documents as the end signal.
   */
  readonly nextCursor: string | undefined;
}

/**
 * Read one customers response.
 *
 * `pagination.next` is the provider's own end-of-data signal the way Metrifox's
 * `meta.next_page` and Stripe's `has_more` are. `null` and an absent field both
 * mean the same thing here, which `asString` already collapses.
 */
export function parseCustomersPage(json: unknown): StiggPage {
  const body = asRecord(json);
  const data = asArray(body?.["data"]);
  const pagination = asRecord(body?.["pagination"]);

  return {
    records: data.filter(
      (row): row is RawRecord => asRecord(row) !== undefined,
    ),
    nextCursor: asString(pagination?.["next"]),
  };
}

// ---------------------------------------------------------------------------
// Synthesized fields
// ---------------------------------------------------------------------------

/**
 * The stable synthetic id for a customer's billing contact.
 *
 * ALGORITHM v1 — changing this re-keys every existing Stigg contact. `Contact`
 * is unique on `(integrationId, externalSourceId)`, so an id that shifts
 * between runs does not error: it silently inserts a duplicate person and
 * orphans the old row.
 *
 * A *constant* slot, as Stripe's and Chargebee's are: there is exactly one
 * contact per customer by construction, so deriving the id from the email would
 * buy nothing and cost everything — an address correction would re-key the row.
 * Stigg slugs cannot contain `:`, so this cannot collide with a customer id.
 */
export function stiggContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing-contact record for one Stigg customer.
 *
 * Deliberately not a spread of the customer, for the same two reasons Stripe's
 * `synthesizeContact` is not: `externalIdOf` falls back to `id` for customers,
 * so a contact carrying the customer's `id` would make that fallback ambiguous;
 * and `STIGG_CONTACT_FIELDS` is a static list, so a spread would put every
 * customer field onto contact records the mapping editor never offers.
 *
 * Stigg has no `phone`, so that key is absent relative to Stripe's version.
 *
 * Read from the **raw** customer, not the record `withCustomerName` patched:
 * that fallback makes every nameless customer's name equal to its id, which
 * would shadow the email local part this function prefers. The caller passes
 * the record Stigg actually returned.
 *
 * @returns The record, or undefined only when the customer has no id, which
 *   nothing downstream could key the row by. Every other customer yields a
 *   contact: the id is the final name fallback, so the required
 *   `Contact.name` is always non-empty.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const name = nonEmpty(asString(customer["name"])?.trim());
  const email = nonEmpty(asString(customer["email"])?.trim());

  // Three layers, best first. Stigg's `name` is whatever was put there — a
  // person for a consumer business, a company for a B2B one. The email local
  // part is the fallback, which is at least recognisable to whoever set the
  // address. The customer id is last so an email is never shadowed by it, and
  // so a customer with neither still produces the required `Contact.name`.
  const contactName =
    name ?? (email === undefined ? customerId : localPart(email));

  return {
    contact_id: stiggContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    customer_id: customerId,
    // The customer's effective name, whole: the id the customer record falls
    // back to when Stigg gave no name.
    customer_name: name ?? customerId,
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

/**
 * The name to write for a Stigg customer when Stigg did not give one.
 *
 * `Customer.name` is required, while Stigg's `name` is nullable — so a nameless
 * customer would be rejected for "Name is required" on every sync, forever, and
 * never appear. The customer's own id is the fallback, deliberately: it always
 * exists, it is stable, and it is a recognisable handle for a record the user
 * can then rename by hand.
 *
 * Returning a spreadable object rather than a value keeps a missing id from
 * writing `name: undefined` onto the record, which the mapping editor would
 * then offer as a field that is always blank. A name already present is left
 * untouched: this is a fallback, not an overwrite.
 */
export function withCustomerName(customer: RawRecord): RawRecord {
  const id = asString(customer["id"]);
  if (id === undefined) return {};

  return nonEmpty(asString(customer["name"])?.trim()) === undefined
    ? { name: id }
    : {};
}

/**
 * The `crossRef.stripe` source, flattened onto the customer record.
 *
 * A Stigg customer's link to its Stripe counterpart lives in `integrations[]`
 * as `{ vendorIdentifier: "STRIPE", syncedEntityId }`. `readPath` walks dot
 * segments with own-property guards but cannot index an array, so a mapping
 * rule cannot reach `integrations.0.syncedEntityId`; the handler flattens the
 * Stripe id onto the record as `stripe_customer_id` while it still has the
 * array.
 *
 * Deliberately **not** read from `billingId`. That field names the customer in
 * whichever billing provider is connected — Stripe **or** Zuora — so feeding it
 * to `crossRef.stripe` would assert a Stripe id that may be a Zuora entity. It
 * goes to `customFields.billing_id` in the defaults instead.
 *
 * @returns `{ stripe_customer_id }` when a STRIPE integration carries a
 *   non-empty `syncedEntityId`, otherwise `{}` so no rule fires. A missing or
 *   non-Stripe list is the safe direction: no field, no cross-reference, no
 *   false join.
 */
export function withStripeLink(customer: RawRecord): RawRecord {
  const stripe = asArray(customer["integrations"])
    .map((entry) => asRecord(entry))
    .find((integration) => asString(integration?.["vendorIdentifier"]) === "STRIPE");

  const syncedEntityId = asString(stripe?.["syncedEntityId"]);
  return syncedEntityId === undefined ? {} : { stripe_customer_id: syncedEntityId };
}
