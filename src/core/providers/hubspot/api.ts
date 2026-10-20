/**
 * HubSpot API surface shared by the sync handlers and field discovery.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import { asArray, asRecord, asString } from "../http";

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
  agreement: "deals",
  agreementItem: "line_items",
} as const;

export type HubspotObject = keyof typeof HUBSPOT_OBJECT_PATH;

/**
 * The HubSpot object name for one of our target objects, or undefined when
 * HubSpot has no counterpart. Discovery uses this to answer for the objects a
 * function declares but this provider does not serve — a `subscription` here
 * has no HubSpot object, and returning an empty field list is honest where a
 * thrown error would break the whole mapping editor.
 */
export function hubspotObjectPathIfSupported(
  object: TargetObject
): string | undefined {
  return (HUBSPOT_OBJECT_PATH as Readonly<Record<string, string>>)[object];
}

/**
 * The HubSpot object name for one of our target objects.
 *
 * Throws rather than returning undefined for an object this provider does not
 * serve. The sync engine and the discovery service both iterate the objects the
 * *function* declares, so a handler can only ever be handed objects it claims —
 * and a thrown error names a registration mistake at once, where a silently
 * undefined path would build a URL ending in "/undefined" and report a 404 from
 * HubSpot instead.
 */
export function hubspotObjectPath(object: TargetObject): string {
  const path = hubspotObjectPathIfSupported(object);
  if (path === undefined) {
    throw new Error(`HubSpot does not serve '${object}'`);
  }
  return path;
}

/** A paginated CRM objects URL with HubSpot's query parameters applied. */
export function hubspotObjectsUrl(args: {
  object: TargetObject;
  properties: readonly string[];
  associations?: readonly string[];
  after?: string;
}): string {
  const url = new URL(
    `/crm/v3/objects/${hubspotObjectPath(args.object)}`,
    hubspotApiBase()
  );
  url.searchParams.set("limit", String(hubspotPageSize()));
  if (args.properties.length > 0) {
    url.searchParams.set("properties", args.properties.join(","));
  }
  if (args.associations !== undefined && args.associations.length > 0) {
    url.searchParams.set("associations", args.associations.join(","));
  }
  if (args.after !== undefined) url.searchParams.set("after", args.after);
  return url.toString();
}

/**
 * HubSpot property names are lowercase alphanumerics and underscores.
 * Anything else is a user typing something into the mapping editor that
 * HubSpot will reject, so drop it rather than sending a request we know fails.
 */
const PROPERTY_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Turn mapped source paths, plus the properties a handler needs for its own
 * synthesis, into the `properties` query parameter.
 *
 * Mapped paths look like `properties.domain`; HubSpot wants a bare comma list
 * of property names, and only returns properties you name, so this is what
 * decides whether a mapped field — or a synthesized status — arrives at all.
 */
export function propertiesParam(
  sourcePaths: readonly string[],
  required: readonly string[] = []
): string[] {
  const names = new Set<string>();
  for (const name of required) {
    if (PROPERTY_NAME.test(name)) names.add(name);
  }
  for (const path of sourcePaths) {
    if (!path.startsWith("properties.")) continue;
    const name = path.slice("properties.".length);
    // Nested paths under a property are not a thing in HubSpot's flat
    // property bag, so a dotted remainder is a mapping mistake.
    if (PROPERTY_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Properties the deal handler reads even when the user mapped none of them.
 *
 * The closed flags are the only stable status vocabulary HubSpot offers:
 * `dealstage` is a per-pipeline id, but these three are maintained by HubSpot
 * itself. The rest supply the agreement's required name, dates and currency.
 */
export const HUBSPOT_DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "pipeline",
  "createdate",
  "closedate",
  "deal_currency_code",
  "hs_is_closed",
  "hs_is_closed_won",
  "hs_is_closed_lost",
] as const;

/**
 * Properties the line-item handler reads even when the user mapped none.
 *
 * `hs_product_id` is kept even though no HubSpot catalog handler exists yet:
 * it is the only link from a deal line to what was sold, and the agreement
 * item writer retains an unresolved provider id for a later relink.
 */
export const HUBSPOT_LINE_ITEM_PROPERTIES = [
  "name",
  "quantity",
  "price",
  "amount",
  "discount",
  "hs_product_id",
  "hs_sku",
  "hs_line_item_currency_code",
  "hs_position_on_quote",
  "hs_recurring_billing_number_of_payments",
  "recurringbillingfrequency",
] as const;

/** The id of the first record associated under `objectType`, if any. */
export function hubspotFirstAssociationId(
  record: RawRecord,
  objectType: string
): string | undefined {
  const associations = asRecord(record["associations"]);
  const group = asRecord(associations?.[objectType]);
  const first = asRecord(asArray(group?.["results"])[0]);
  return asString(first?.["id"]);
}

/** The company a deal or contact hangs off, as HubSpot's own id. */
export function hubspotCompanyId(record: RawRecord): string | undefined {
  return hubspotFirstAssociationId(record, "companies");
}

/** The deal a line item belongs to, as HubSpot's own id. */
export function hubspotDealId(record: RawRecord): string | undefined {
  return hubspotFirstAssociationId(record, "deals");
}

function propertyString(
  properties: Record<string, unknown>,
  name: string
): string | undefined {
  return asString(properties[name]);
}

/** HubSpot's booleans are the strings "true" and "false". */
function isTrue(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase() === "true";
}

/**
 * Translate a deal's closed flags into our agreement-status vocabulary.
 *
 * Open deals are `draft` — not yet agreed. Closed-won is `active`; closed-lost
 * is `canceled`. A deal HubSpot reports as closed without saying which outcome
 * it had leaves the status unset rather than guessing, which is the same landing
 * state `Agreement.status` uses for every provider that did not say.
 */
export function hubspotDealStatus(
  properties: Record<string, unknown>
): string | undefined {
  if (isTrue(propertyString(properties, "hs_is_closed_won"))) return "active";
  if (isTrue(propertyString(properties, "hs_is_closed_lost"))) return "canceled";
  if (isTrue(propertyString(properties, "hs_is_closed"))) return undefined;
  return "draft";
}

const DEAL_METADATA_PROPERTIES = [
  "dealstage",
  "pipeline",
  "amount",
  "dealtype",
  "closedate",
  "hubspot_owner_id",
  "hs_is_closed",
  "hs_is_closed_won",
  "hs_is_closed_lost",
] as const;

const LINE_ITEM_METADATA_PROPERTIES = [
  "name",
  "price",
  "amount",
  "discount",
  "hs_product_id",
  "hs_sku",
  "hs_line_item_currency_code",
  "hs_position_on_quote",
  "recurringbillingfrequency",
  "hs_recurring_billing_number_of_payments",
] as const;

function metadataOf(
  properties: Record<string, unknown>,
  names: readonly string[]
): string {
  const metadata: Record<string, string> = {};
  for (const name of names) {
    const value = propertyString(properties, name);
    if (value !== undefined) metadata[name] = value;
  }
  return JSON.stringify(metadata);
}

/**
 * Synthesize the agreement fields a deal record supplies.
 *
 * The spread comes first so a provider property of the same name can never
 * shadow a synthesized value. `properties` and `associations` survive
 * underneath, so a user may still map any raw deal property directly.
 */
export function flattenHubspotDeal(record: RawRecord): RawRecord {
  const properties = asRecord(record["properties"]) ?? {};
  const id = asString(record["id"]);
  const dealName = propertyString(properties, "dealname")?.trim();
  const name =
    dealName === undefined || dealName === ""
      ? id === undefined
        ? "Deal"
        : `Deal ${id}`
      : dealName;

  const created = propertyString(properties, "createdate");
  const closeDate = propertyString(properties, "closedate");
  const closed =
    isTrue(propertyString(properties, "hs_is_closed")) ||
    isTrue(propertyString(properties, "hs_is_closed_won")) ||
    isTrue(propertyString(properties, "hs_is_closed_lost"));
  const currency = propertyString(properties, "deal_currency_code");
  const status = hubspotDealStatus(properties);

  return {
    ...record,
    agreement_name: name,
    agreement_type: "deal",
    ...(status === undefined ? {} : { agreement_status: status }),
    ...(created === undefined ? {} : { effective_date: created }),
    ...(closed && closeDate !== undefined ? { end_date: closeDate } : {}),
    ...(currency === undefined ? {} : { currency }),
    provider_metadata: metadataOf(properties, DEAL_METADATA_PROPERTIES),
  };
}

/**
 * Synthesize one agreement-item record from a line item and the deal it
 * belongs to.
 *
 * `agreement_id` is injected from the association the handler read, not taken
 * from any field on the payload: this is a writer that deletes, so a line must
 * not be able to name a different parent than the deal it was read under.
 */
export function flattenHubspotLineItem(
  record: RawRecord,
  agreementId: string,
  position: number
): RawRecord {
  const properties = asRecord(record["properties"]) ?? {};
  return {
    ...record,
    agreement_id: agreementId,
    position,
    provider_metadata: metadataOf(properties, LINE_ITEM_METADATA_PROPERTIES),
  };
}
