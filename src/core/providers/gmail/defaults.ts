/**
 * Suggested Gmail communication mappings.
 *
 * Every source path is produced by `parseGmailMessage`; the parser already
 * translates Gmail's MIME structure into these flat strings. Bodies are mapped
 * without a transform and without truncation.
 */

import type { FieldMappingRule } from "../../types/mapping";

export const gmailCommunicationDefaults: FieldMappingRule[] = [
  {
    sourceFieldPath: "fromEmail",
    targetObject: "message",
    targetFieldPath: "fromEmail",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "fromName",
    targetObject: "message",
    targetFieldPath: "fromName",
    transform: "trim",
  },
  {
    sourceFieldPath: "toEmailsCsv",
    targetObject: "message",
    targetFieldPath: "toEmails",
    transform: "none",
  },
  {
    sourceFieldPath: "ccEmailsCsv",
    targetObject: "message",
    targetFieldPath: "ccEmails",
    transform: "none",
  },
  {
    sourceFieldPath: "subject",
    targetObject: "message",
    targetFieldPath: "subject",
    transform: "none",
  },
  {
    sourceFieldPath: "snippet",
    targetObject: "message",
    targetFieldPath: "snippet",
    transform: "none",
  },
  {
    sourceFieldPath: "bodyText",
    targetObject: "message",
    targetFieldPath: "bodyText",
    transform: "none",
  },
  {
    sourceFieldPath: "bodyHtml",
    targetObject: "message",
    targetFieldPath: "bodyHtml",
    transform: "none",
  },
  {
    sourceFieldPath: "sentAtIso",
    targetObject: "message",
    targetFieldPath: "sentAt",
    transform: "none",
  },
  {
    sourceFieldPath: "direction",
    targetObject: "message",
    targetFieldPath: "direction",
    transform: "none",
  },
  {
    sourceFieldPath: "threadId",
    targetObject: "message",
    targetFieldPath: "threadId",
    transform: "none",
  },
];
