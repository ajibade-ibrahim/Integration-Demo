/**
 * Salesforce field discovery via sObject describe.
 *
 * Describe returns every field on the object including custom ones (the `__c`
 * suffix), which is what makes the mapping editor useful against a real org
 * rather than only against standard fields.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { asArray, asRecord, asString, createProviderSession } from "../http";
import { describeUrl, salesforceObject } from "./api";

export const salesforceFieldDiscovery: FieldDiscovery = {
  async discover(
    ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    const session = createProviderSession(ctx, "Salesforce");
    const body = asRecord(
      await session.getJson(describeUrl(session.metadata, salesforceObject(object)))
    );

    const fields: DiscoveredFieldDef[] = [];

    for (const entry of asArray(body?.["fields"])) {
      const field = asRecord(entry);
      if (field === undefined) continue;

      // Describe reports every field on the object; only the queryable ones can
      // appear in a SELECT, so offering the rest would produce mappings that
      // fail at sync time.
      if (field["filterable"] === false && field["sortable"] === false) continue;

      const name = asString(field["name"]);
      if (name === undefined) continue;

      fields.push({
        path: name,
        label: asString(field["label"]) ?? name,
        type: asString(field["type"]) ?? "string",
      });
    }

    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
  },
};
