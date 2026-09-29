/**
 * Chargebee REST API helpers: URL builders, authentication header parsing,
 * cursor pagination, and contact synthesis.
 *
 * Docs: https://apidocs.chargebee.com/v2/#customers
 */

import type { RawRecord } from "../../types/common";
import { asArray, asRecord, asString } from "../http";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const CHARGEBEE_MAX_PAGES = 1000;

export function chargebeePageSize(): number {
  const raw = process.env["CHARGEBEE_PAGE_SIZE"];
  if (raw === undefined || raw === "") return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * Parse a full `site:api_key` string or raw API key into site and key components.
 */
export function parseChargebeeCredential(credential: string): {
  site: string | undefined;
  apiKey: string;
} {
  const trimmed = credential.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    return {
      site: trimmed.slice(0, colonIndex).trim(),
      apiKey: trimmed.slice(colonIndex + 1).trim(),
    };
  }
  return {
    site: undefined,
    apiKey: trimmed,
  };
}

/**
 * Chargebee uses Basic HTTP Authentication with the API key as the username
 * and an empty password: `Authorization: Basic <base64(apiKey + ":")>`.
 */
export function chargebeeAuthHeaders(credential: string): Record<string, string> {
  const { apiKey } = parseChargebeeCredential(credential);
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
  };
}

/**
 * Base URL for the Chargebee API.
 *
 * Overridable via `CHARGEBEE_API_BASE` for local dev/test mocks.
 * Defaults to `https://{site}.chargebee.com`.
 */
export function chargebeeApiBase(site: string): string {
  const envBase = process.env["CHARGEBEE_API_BASE"];
  const resolved =
    envBase !== undefined && envBase !== ""
      ? envBase
      : `https://${site}.chargebee.com`;

  const { protocol, hostname } = new URL(resolved);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (protocol !== "https:" && !loopback) {
    throw new Error(
      `CHARGEBEE_API_BASE must use https (or localhost); got '${resolved}'`
    );
  }
  return resolved;
}

export function customersUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/customers`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export interface ChargebeeCustomersPage {
  readonly records: readonly RawRecord[];
  readonly nextOffset: string | undefined;
}

/**
 * Parse a Chargebee customer list response envelope:
 * `{ list: [ { customer: { ... } } ], next_offset: "..." }`
 */
export function parseCustomersPage(json: unknown): ChargebeeCustomersPage {
  const body = asRecord(json);
  const list = asArray(body?.["list"]);

  const records: RawRecord[] = [];
  for (const item of list) {
    const customer = asRecord(asRecord(item)?.["customer"]);
    if (customer !== undefined) {
      records.push(customer);
    }
  }

  const nextOffset = asString(body?.["next_offset"]);

  return {
    records,
    nextOffset: nextOffset === "" ? undefined : nextOffset,
  };
}

/**
 * Chargebee's `created_at` (Unix epoch seconds) to ISO string.
 */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Synthetic contact ID for Chargebee customer.
 */
export function chargebeeContactExternalId(customerId: string): string {
  return `${customerId}:contact`;
}

/**
 * Build the billing contact record for a Chargebee customer.
 */
export function synthesizeContact(customer: RawRecord): RawRecord | undefined {
  const customerId = asString(customer["id"]);
  if (customerId === undefined) return undefined;

  const firstName = asString(customer["first_name"])?.trim();
  const lastName = asString(customer["last_name"])?.trim();

  const billing = asRecord(customer["billing_address"]);
  const billingFirstName = asString(billing?.["first_name"])?.trim();
  const billingLastName = asString(billing?.["last_name"])?.trim();

  let nameParts = [firstName, lastName].filter(
    (part): part is string => part !== undefined && part !== ""
  );
  if (nameParts.length === 0) {
    nameParts = [billingFirstName, billingLastName].filter(
      (part): part is string => part !== undefined && part !== ""
    );
  }

  const company = asString(customer["company"])?.trim();

  const email =
    asString(customer["email"])?.trim() ??
    asString(billing?.["email"])?.trim();

  const phone =
    asString(customer["phone"])?.trim() ??
    asString(billing?.["phone"])?.trim();

  const contactName =
    nameParts.length > 0
      ? nameParts.join(" ")
      : email !== undefined
      ? localPart(email)
      : company;

  if (contactName === undefined || contactName === "") return undefined;

  return {
    contact_id: chargebeeContactExternalId(customerId),
    contact_name: contactName,
    email: email ?? null,
    phone: phone ?? null,
    customer_id: customerId,
    customer_name: company ?? contactName,
  };
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// ---------------------------------------------------------------------------
// Catalog V2 (Item Families, Items, Item Prices)
// ---------------------------------------------------------------------------

export function itemFamiliesUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/item_families`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function itemsUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/items`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function itemPricesUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/item_prices`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export interface ChargebeeListPage {
  readonly records: readonly RawRecord[];
  readonly nextOffset: string | undefined;
}

export function parseEnvelopePage(
  json: unknown,
  entityKey: string
): ChargebeeListPage {
  const body = asRecord(json);
  const list = asArray(body?.["list"]);

  const records: RawRecord[] = [];
  for (const item of list) {
    const record = asRecord(asRecord(item)?.[entityKey]);
    if (record !== undefined) {
      records.push(record);
    }
  }

  const nextOffset = asString(body?.["next_offset"]);

  return {
    records,
    nextOffset: nextOffset === "" ? undefined : nextOffset,
  };
}

export function parseItemFamiliesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_family");
}

export function parseItemsPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item");
}

export function parseItemPricesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_price");
}

// ---------------------------------------------------------------------------
// Entitlements (Features, Item Entitlements)
// ---------------------------------------------------------------------------

/**
 * The site's feature *definitions*.
 *
 * Read for their ids only: each one is the parent segment of a
 * `featureItemEntitlementsUrl` request. Also the cheap "does this site use
 * Entitlements at all?" answer — a site with no features yields an empty first
 * page and the per-feature pass never starts.
 */
export function featuresUrl(
  site: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(`${base}/api/v2/features`);
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

/**
 * The items one feature is attached to.
 *
 * Per feature because Chargebee has no site-wide item-entitlement list
 * (`/api/v2/item_entitlements` is a 404). Per feature rather than per item
 * because a catalog usually defines fewer features than items, so this is the
 * shorter fan-out of the two.
 *
 * The id is percent-encoded: it is a path segment built from response data.
 */
export function featureItemEntitlementsUrl(
  site: string,
  featureId: string,
  limit: number,
  offset?: string
): string {
  const base = chargebeeApiBase(site).replace(/\/$/, "");
  const url = new URL(
    `${base}/api/v2/features/${encodeURIComponent(featureId)}/item_entitlements`
  );
  url.searchParams.set("limit", String(limit));
  if (offset !== undefined && offset !== "") {
    url.searchParams.set("next_offset", offset);
  }
  return url.toString();
}

export function parseFeaturesPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "feature");
}

/**
 * Item entitlements, passed through as they arrive.
 *
 * No flattening is needed, unlike Stripe's attachment: Chargebee puts
 * `feature_id`, `feature_name` and the parent `item_id` at the top level of
 * every record, so the offering link is read from the payload itself.
 */
export function parseItemEntitlementsPage(json: unknown): ChargebeeListPage {
  return parseEnvelopePage(json, "item_entitlement");
}

export function flattenItemPrice(itemPrice: RawRecord): RawRecord {
  const periodUnit = asString(itemPrice["period_unit"])?.toLowerCase();
  const period = itemPrice["period"];

  let interval: string = "one_time";
  if (periodUnit === "day" || periodUnit === "week" || periodUnit === "month" || periodUnit === "year") {
    interval = periodUnit;
  }

  const name = asString(itemPrice["name"]) ?? asString(itemPrice["id"]) ?? "Price";
  const createdAt = epochToIso(itemPrice["created_at"]);

  return {
    price_name: name,
    offering_id: asString(itemPrice["item_id"]),
    interval,
    interval_count: typeof period === "number" ? period : 1,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  };
}
