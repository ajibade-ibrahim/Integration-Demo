/**
 * Mock field discovery — the static equivalent of HubSpot's properties API and
 * Salesforce's describe call.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";
import { MOCK_COMPANY_FIELDS, MOCK_PERSON_FIELDS } from "./fixtures";

export const mockFieldDiscovery: FieldDiscovery = {
  async discover(
    _ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    return object === "customer"
      ? [...MOCK_COMPANY_FIELDS]
      : [...MOCK_PERSON_FIELDS];
  },
};
