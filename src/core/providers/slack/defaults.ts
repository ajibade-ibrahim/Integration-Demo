/**
 * Suggested Slack communication mappings.
 *
 * Every source path is produced by the Slack handler. A Slack message has no
 * separate To/Cc lists and no subject — the conversation is the recipient, and
 * its label and mapped customer are stored on the message from the mapping
 * rather than mapped. Only the source-specific message fields are offered.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const slackCommunicationDefaults: FieldMappingRule[] = [
  {
    sourceFieldPath: "authorId",
    targetObject: "slackMessage",
    targetFieldPath: "authorId",
    transform: "trim",
  },
  {
    sourceFieldPath: "authorName",
    targetObject: "slackMessage",
    targetFieldPath: "authorName",
    transform: "trim",
  },
  {
    sourceFieldPath: "authorEmail",
    targetObject: "slackMessage",
    targetFieldPath: "authorEmail",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "threadRootTs",
    targetObject: "slackMessage",
    targetFieldPath: "threadRootTs",
    transform: "none",
  },
  {
    sourceFieldPath: "snippet",
    targetObject: "slackMessage",
    targetFieldPath: "snippet",
    transform: "none",
  },
  {
    sourceFieldPath: "bodyText",
    targetObject: "slackMessage",
    targetFieldPath: "bodyText",
    transform: "none",
  },
  {
    sourceFieldPath: "sentAtIso",
    targetObject: "slackMessage",
    targetFieldPath: "sentAt",
    transform: "none",
  },
  {
    sourceFieldPath: "direction",
    targetObject: "slackMessage",
    targetFieldPath: "direction",
    transform: "none",
  },
];
