/**
 * Static Slack field discovery.
 *
 * Slack has no schema endpoint for message contents, and the raw record shape
 * is produced entirely by our handler. Listing it statically keeps the editor
 * stable: a channel that happens to have no external author email today must
 * not make the field disappear from the mapping UI tomorrow.
 */

import type { TargetObject } from "../../types/common";
import type {
  DiscoveredFieldDef,
  FieldDiscovery,
  HandlerContext,
} from "../../types/registry";

export const SLACK_MESSAGE_FIELDS: DiscoveredFieldDef[] = [
  { path: "ts", label: "Slack timestamp", type: "string" },
  { path: "channelId", label: "Conversation ID", type: "string" },
  { path: "threadRootTs", label: "Thread root timestamp", type: "string" },
  { path: "conversationLabel", label: "Conversation label", type: "string" },
  { path: "conversationKind", label: "Conversation kind", type: "string" },
  { path: "authorId", label: "Author Slack user ID", type: "string" },
  { path: "authorName", label: "Author name", type: "string" },
  { path: "authorEmail", label: "Author email (external authors only)", type: "string" },
  { path: "bodyText", label: "Message body", type: "string" },
  { path: "snippet", label: "Snippet", type: "string" },
  { path: "sentAtIso", label: "Sent at (ISO 8601)", type: "datetime" },
  { path: "direction", label: "Direction (sent or received)", type: "string" },
];

export const slackFieldDiscovery: FieldDiscovery = {
  async discover(
    _ctx: Omit<HandlerContext, "requestedSourcePaths">,
    object: TargetObject
  ): Promise<readonly DiscoveredFieldDef[]> {
    return object === "slackMessage" ? [...SLACK_MESSAGE_FIELDS] : [];
  },
};
