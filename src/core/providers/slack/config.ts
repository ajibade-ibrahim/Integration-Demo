/**
 * Slack-specific tuning.
 *
 * The conversation detail page is bounded so one busy channel cannot turn a
 * page load into an unbounded query. The bound is deliberately independent of
 * the sync page size: it limits what the UI reads, not what the provider
 * fetches, and a smaller window is still a valid view of the same conversation.
 */

export const DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT = 500;
export const MIN_SLACK_CONVERSATION_MESSAGE_LIMIT = 1;
export const MAX_SLACK_CONVERSATION_MESSAGE_LIMIT = 2000;

/**
 * Latest stored messages to load for one conversation.
 *
 * Read through a function so a changed environment variable takes effect
 * without a rebuild. A malformed value falls back to the default; a numeric
 * value is clamped rather than rejected, because the page must still render and
 * the safest interpretation of "0" or "99999" is the nearest useful bound.
 */
export function slackConversationMessageLimit(): number {
  const raw = process.env["SLACK_CONVERSATION_MESSAGE_LIMIT"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT;
  }

  return Math.min(
    MAX_SLACK_CONVERSATION_MESSAGE_LIMIT,
    Math.max(MIN_SLACK_CONVERSATION_MESSAGE_LIMIT, parsed)
  );
}
