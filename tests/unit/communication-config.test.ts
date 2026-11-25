import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  communicationConfig,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SYNC_OVERLAP_DAYS,
  MAX_PAGE_SIZE,
} from "@/core/communication/config";

const KEYS = [
  "COMMUNICATION_LOOKBACK_DAYS",
  "COMMUNICATION_SYNC_OVERLAP_DAYS",
  "COMMUNICATION_PAGE_SIZE",
  "GMAIL_LOOKBACK_DAYS",
  "GMAIL_SYNC_OVERLAP_DAYS",
  "GMAIL_PAGE_SIZE",
] as const;

const saved = new Map(
  KEYS.map((key) => [key, process.env[key]] as const)
);

function clear(): void {
  for (const key of KEYS) delete process.env[key];
}

beforeEach(clear);

afterEach(() => {
  clear();
  for (const [key, value] of saved) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe("communication configuration", () => {
  it("keeps the documented defaults", () => {
    expect(communicationConfig()).toMatchObject({
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      overlapDays: DEFAULT_SYNC_OVERLAP_DAYS,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("still accepts the legacy GMAIL_* names", () => {
    process.env["GMAIL_LOOKBACK_DAYS"] = "30";
    process.env["GMAIL_SYNC_OVERLAP_DAYS"] = "3";

    expect(communicationConfig()).toMatchObject({
      lookbackDays: 30,
      overlapDays: 3,
    });
  });

  it("prefers the communication name when both are set", () => {
    process.env["COMMUNICATION_LOOKBACK_DAYS"] = "10";
    process.env["GMAIL_LOOKBACK_DAYS"] = "30";

    expect(communicationConfig().lookbackDays).toBe(10);
  });

  it("falls through an invalid new name to the legacy one", () => {
    process.env["COMMUNICATION_LOOKBACK_DAYS"] = "not-a-number";
    process.env["GMAIL_LOOKBACK_DAYS"] = "45";

    expect(communicationConfig().lookbackDays).toBe(45);
  });

  it("caps page size rather than accepting an unbounded request", () => {
    process.env["COMMUNICATION_PAGE_SIZE"] = "9999";

    expect(communicationConfig().pageSize).toBe(MAX_PAGE_SIZE);
  });
});
