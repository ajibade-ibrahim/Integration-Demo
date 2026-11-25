/**
 * Slack conversation-kind display and query-parameter handling.
 *
 * Kept beside the customer pages because it is presentation policy: the stored
 * kind is a stable string, the labels are UI copy, and an unknown filter value
 * must fall back to "All" rather than failing a read-only page.
 */

import type { SlackConversationKind } from "@/core/communication/types";

export const SLACK_CONVERSATION_KIND_LABELS: Record<
  SlackConversationKind,
  { singular: string; plural: string }
> = {
  shared_channel: { singular: "Shared channel", plural: "Shared channels" },
  connect_dm: { singular: "Connect DM", plural: "Connect DMs" },
  group_dm: { singular: "Group DM", plural: "Group DMs" },
};

const FILTER_ORDER: SlackConversationKind[] = [
  "shared_channel",
  "connect_dm",
  "group_dm",
];

export interface SlackConversationKindFilter {
  key: string;
  label: string;
  kind?: SlackConversationKind;
}

export const SLACK_CONVERSATION_KIND_FILTERS: SlackConversationKindFilter[] = [
  { key: "all", label: "All" },
  ...FILTER_ORDER.map((kind) => ({
    key: kind,
    label: SLACK_CONVERSATION_KIND_LABELS[kind].plural,
    kind,
  })),
];

export function isSlackConversationKind(
  value: unknown
): value is SlackConversationKind {
  return (
    typeof value === "string" &&
    (FILTER_ORDER as readonly string[]).includes(value)
  );
}
