/**
 * Static Gmail field discovery.
 *
 * Gmail has no schema/describe endpoint for a message body, and the raw record
 * shape is produced entirely by our parser. Listing it statically is therefore
 * more accurate than sampling one message: a message without an HTML part
 * should not make the HTML target disappear from the editor.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";

export const GMAIL_MESSAGE_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Message ID", type: "string" },
  { path: "threadId", label: "Thread ID", type: "string" },
  { path: "fromEmail", label: "From email", type: "string" },
  { path: "fromName", label: "From name", type: "string" },
  { path: "toEmailsCsv", label: "To addresses (comma-separated)", type: "string" },
  { path: "ccEmailsCsv", label: "Cc addresses (comma-separated)", type: "string" },
  { path: "subject", label: "Subject", type: "string" },
  { path: "snippet", label: "Snippet", type: "string" },
  { path: "bodyText", label: "Body (plain text)", type: "string" },
  { path: "bodyHtml", label: "Body (HTML source)", type: "string" },
  { path: "sentAtIso", label: "Sent at (ISO 8601)", type: "datetime" },
  { path: "internalDateMs", label: "Gmail internal date (milliseconds)", type: "string" },
  { path: "direction", label: "Direction (sent or received)", type: "string" },
];

export const gmailFieldDiscovery: FieldDiscovery = {
  async discover(
    _ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    return object === "emailMessage" ? [...GMAIL_MESSAGE_FIELDS] : [];
  },
};
