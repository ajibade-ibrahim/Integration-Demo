import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT,
  MAX_SLACK_CONVERSATION_MESSAGE_LIMIT,
  MIN_SLACK_CONVERSATION_MESSAGE_LIMIT,
  slackConversationMessageLimit,
} from "@/core/providers/slack/config";

const KEY = "SLACK_CONVERSATION_MESSAGE_LIMIT";
const saved = process.env[KEY];

beforeEach(() => {
  delete process.env[KEY];
});

afterEach(() => {
  delete process.env[KEY];
  if (saved !== undefined) process.env[KEY] = saved;
});

describe("Slack conversation message limit", () => {
  it("defaults when unset or blank", () => {
    expect(slackConversationMessageLimit()).toBe(
      DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT
    );

    process.env[KEY] = "   ";
    expect(slackConversationMessageLimit()).toBe(
      DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT
    );
  });

  it("falls back to the default for a malformed value", () => {
    process.env[KEY] = "not-a-number";
    expect(slackConversationMessageLimit()).toBe(
      DEFAULT_SLACK_CONVERSATION_MESSAGE_LIMIT
    );
  });

  it("accepts a value inside the window", () => {
    process.env[KEY] = "25";
    expect(slackConversationMessageLimit()).toBe(25);
  });

  it("clamps below the minimum instead of loading nothing", () => {
    process.env[KEY] = "0";
    expect(slackConversationMessageLimit()).toBe(
      MIN_SLACK_CONVERSATION_MESSAGE_LIMIT
    );

    process.env[KEY] = "-10";
    expect(slackConversationMessageLimit()).toBe(
      MIN_SLACK_CONVERSATION_MESSAGE_LIMIT
    );
  });

  it("clamps above the maximum instead of loading everything", () => {
    process.env[KEY] = "99999";
    expect(slackConversationMessageLimit()).toBe(
      MAX_SLACK_CONVERSATION_MESSAGE_LIMIT
    );
  });
});
