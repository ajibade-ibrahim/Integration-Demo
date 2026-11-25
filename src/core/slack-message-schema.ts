/**
 * The Slack message schema: what a mapped-conversation message can be mapped
 * into.
 *
 * A Slack message has no To/Cc lists and no subject — the conversation is the
 * recipient and its label carries the context. Conversation id/kind/label, the
 * mapped customer, the author-external flag and the member snapshot are derived
 * by the handler, not mappable target fields.
 */

import type { ObjectSchema } from "./object-schema";
import { MESSAGE_DIRECTIONS } from "./types/common";

export const SLACK_MESSAGE_SCHEMA: ObjectSchema = {
  object: "slackMessage",
  label: "Slack message",
  fields: [
    {
      name: "authorId",
      label: "Author Slack user ID",
      kind: "string",
      required: true,
      maxLength: 64,
    },
    { name: "authorName", label: "Author name", kind: "string", maxLength: 255 },
    { name: "authorEmail", label: "Author email", kind: "email", maxLength: 254 },
    {
      name: "threadRootTs",
      label: "Thread root timestamp",
      kind: "string",
      required: true,
      maxLength: 64,
    },
    { name: "bodyText", label: "Message body", kind: "string" },
    { name: "snippet", label: "Snippet", kind: "string" },
    { name: "sentAt", label: "Sent at", kind: "date", required: true },
    {
      name: "direction",
      label: "Direction",
      kind: "enum",
      enumValues: MESSAGE_DIRECTIONS,
      required: true,
    },
  ],
};
