/**
 * Salesforce API addressing.
 *
 * Every call is addressed to the org's own host, which Salesforce communicates
 * exactly once — in the token response, as `instance_url`. It is captured into
 * token metadata at authorization; this module is where that value is turned
 * back into a URL.
 */

import { isIdentityObject } from "../../identity-schema";
import type { TargetObject } from "../../types/common";
import type { ProviderMetadata } from "../../types/registry";
import { salesforceApiVersion } from "./provider";

/**
 * @throws If `instanceUrl` is missing from token metadata. That should be
 *   impossible — the token parser refuses a response without it — so if it
 *   happens, something replaced the stored metadata and a clear error beats a
 *   request to `undefined/services/data/...`.
 */
export function instanceUrl(metadata: ProviderMetadata): string {
  const url = metadata["instanceUrl"];
  if (url === undefined || url === "") {
    throw new Error(
      "Salesforce integration has no instance_url stored; reconnect it"
    );
  }
  return url.replace(/\/+$/, "");
}

export function queryUrl(metadata: ProviderMetadata, soql: string): string {
  const url = new URL(
    `/services/data/${salesforceApiVersion()}/query`,
    instanceUrl(metadata)
  );
  url.searchParams.set("q", soql);
  return url.toString();
}

export function describeUrl(
  metadata: ProviderMetadata,
  objectName: string
): string {
  return new URL(
    `/services/data/${salesforceApiVersion()}/sobjects/${objectName}/describe`,
    instanceUrl(metadata)
  ).toString();
}

/** `nextRecordsUrl` is a host-relative path; rejoin it with the org host. */
export function nextPageUrl(
  metadata: ProviderMetadata,
  nextRecordsUrl: string
): string {
  return new URL(nextRecordsUrl, instanceUrl(metadata)).toString();
}

/** Our target objects expressed as Salesforce sObject names. */
export const SALESFORCE_OBJECT = {
  customer: "Account",
  contact: "Contact",
} as const;

/**
 * The sObject name for one of our target objects.
 *
 * Throws for an object this handler does not serve — see the note on
 * `hubspotObjectPath`. An undefined sObject would reach Salesforce as
 * `FROM undefined`, which comes back as a SOQL parse error rather than
 * anything that names the real mistake.
 */
export function salesforceObject(object: TargetObject): string {
  if (!isIdentityObject(object)) {
    throw new Error(`Salesforce's identity handler does not serve '${object}'`);
  }
  return SALESFORCE_OBJECT[object];
}
