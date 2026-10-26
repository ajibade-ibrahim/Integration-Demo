/**
 * HubSpot field discovery.
 *
 * Reads the properties API so the mapping editor's source dropdown shows what
 * this account actually has, custom properties included, rather than a
 * hardcoded guess at HubSpot's standard schema. The `crm.schemas.*.read` scopes
 * requested for each function exist precisely to make these calls work.
 *
 * The `agreement` function declares five objects but HubSpot serves only two of
 * them — deals and line items. The rest return an empty field list rather than
 * throwing: the discovery service asks for every object the function owns, and
 * one unsupported object must not take the whole editor down.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asArray, asRecord, asString, createProviderSession } from "../http";
import { hubspotApiBase, hubspotObjectPathIfSupported } from "./api";

const AGREEMENT_FIELDS: readonly DiscoveredFieldDef[] = [
  {
    path: "agreement_name",
    label: "Name (synthesized from Deal name, with an id fallback)",
    type: "string",
  },
  {
    path: "agreement_type",
    label: "Agreement type (synthesized; always deal here)",
    type: "string",
  },
  {
    path: "currency",
    label: "Currency (synthesized from Deal currency)",
    type: "string",
  },
  {
    path: "provider_metadata",
    label: "Provider metadata (JSON: stage, pipeline, amount and other raw facts)",
    type: "string",
  },
];

const AGREEMENT_ITEM_FIELDS: readonly DiscoveredFieldDef[] = [
  {
    path: "position",
    label: "Position (synthesized order within the deal)",
    type: "number",
  },
  {
    path: "provider_metadata",
    label: "Provider metadata (JSON: price, amount, discount and other raw facts)",
    type: "string",
  },
];

function syntheticFieldsFor(
  object: TargetObject
): readonly DiscoveredFieldDef[] {
  if (object === "agreement") return AGREEMENT_FIELDS;
  if (object === "agreementItem") return AGREEMENT_ITEM_FIELDS;
  return [];
}

export const hubspotFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    const objectPath = hubspotObjectPathIfSupported(object);
    if (objectPath === undefined) return [];

    const session = createProviderSession(ctx, "HubSpot");
    const url = new URL(
      `/crm/v3/properties/${objectPath}`,
      hubspotApiBase()
    );

    const body = asRecord(await session.getJson(url.toString()));
    const synthetic = syntheticFieldsFor(object);
    const fields: DiscoveredFieldDef[] = [...synthetic];

    for (const entry of asArray(body?.["results"])) {
      const field = asRecord(entry);
      if (field === undefined) continue;

      // Hidden and calculated properties are not things a user can meaningfully
      // map from; showing them makes the dropdown unusable.
      if (field["hidden"] === true || field["calculated"] === true) continue;

      const name = asString(field["name"]);
      if (name === undefined) continue;

      fields.push({
        path: `properties.${name}`,
        label: asString(field["label"]) ?? name,
        type: asString(field["type"]) ?? "string",
      });
    }

    const sorted = fields
      .slice(synthetic.length)
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...synthetic, ...sorted];
  },
};
