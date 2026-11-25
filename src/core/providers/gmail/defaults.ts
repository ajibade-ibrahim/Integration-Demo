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
    targetObject: "emailMessage",
    targetFieldPath: "fromEmail",
    transform: "lowercase",
  },
  {
    sourceFieldPath: "fromName",
    targetObject: "emailMessage",
    targetFieldPath: "fromName",
    transform: "trim",
  },
  {
    sourceFieldPath: "toEmailsCsv",
    targetObject: "emailMessage",
    targetFieldPath: "toEmails",
    transform: "none",
  },
  {
    sourceFieldPath: "ccEmailsCsv",
    targetObject: "emailMessage",
    targetFieldPath: "ccEmails",
    transform: "none",
  },
  {
    sourceFieldPath: "subject",
    targetObject: "emailMessage",
    targetFieldPath: "subject",
    transform: "none",
  },
  {
    sourceFieldPath: "snippet",
    targetObject: "emailMessage",
    targetFieldPath: "snippet",
    transform: "none",
  },
  {
    sourceFieldPath: "bodyText",
    targetObject: "emailMessage",
    targetFieldPath: "bodyText",
    transform: "none",
  },
  {
    sourceFieldPath: "bodyHtml",
    targetObject: "emailMessage",
    targetFieldPath: "bodyHtml",
    transform: "none",
  },
  {
    sourceFieldPath: "sentAtIso",
    targetObject: "emailMessage",
    targetFieldPath: "sentAt",
    transform: "none",
  },
  {
    sourceFieldPath: "direction",
    targetObject: "emailMessage",
    targetFieldPath: "direction",
    transform: "none",
  },
  {
    sourceFieldPath: "threadId",
    targetObject: "emailMessage",
    targetFieldPath: "threadId",
    transform: "none",
  },
];
