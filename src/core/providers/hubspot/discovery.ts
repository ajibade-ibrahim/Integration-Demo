/**
 * HubSpot field discovery.
 *
 * Reads the properties API so the mapping editor's source dropdown shows what
 * this account actually has, custom properties included, rather than a
 * hardcoded guess at HubSpot's standard schema. The `crm.schemas.*.read` scopes
 * requested for the identity function exist precisely to make this call work.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asArray, asRecord, asString, createProviderSession } from "../http";
import { HUBSPOT_OBJECT_PATH, hubspotApiBase } from "./api";

export const hubspotFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    const session = createProviderSession(ctx, "HubSpot");
    const url = new URL(
      `/crm/v3/properties/${HUBSPOT_OBJECT_PATH[object]}`,
      hubspotApiBase()
    );

    const body = asRecord(await session.getJson(url.toString()));
    const fields: DiscoveredFieldDef[] = [];

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

    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
  },
};
