/**
 * The source-specific communication schemas the `communication` function owns.
 *
 * Both objects live in one function because they share a sync lifecycle, a
 * retention window and an integration. Each provider's handler declares only
 * the one it writes, so the mapping editor never offers Gmail fields to Slack
 * or the reverse.
 */

import { EMAIL_MESSAGE_SCHEMA } from "./email-message-schema";
import { SLACK_MESSAGE_SCHEMA } from "./slack-message-schema";

export const COMMUNICATION_OBJECT_SCHEMAS = {
  emailMessage: EMAIL_MESSAGE_SCHEMA,
  slackMessage: SLACK_MESSAGE_SCHEMA,
} as const;
