import { describe, expect, it } from "vitest";
import { asArray, asRecord, asString, retryAfterMs } from "@/core/providers/http";

describe("retryAfterMs", () => {
  it("reads delay-seconds", () => {
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs("  30 ")).toBe(30_000);
    expect(retryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:45 GMT", now)).toBe(45_000);
  });

  it("clamps a date in the past to zero rather than a negative wait", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    // A negative sleep would either throw or return instantly depending on the
    // clock; zero says "retry now" unambiguously.
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("caps an absurd wait so one request cannot park the sync indefinitely", () => {
    // A provider asking for an hour, or a skewed clock, should hand back to the
    // run-level retry rather than sitting on the request.
    expect(retryAfterMs("3600")).toBe(15 * 60 * 1000);

    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs("Fri, 02 Jan 2026 00:00:00 GMT", now)).toBe(
      15 * 60 * 1000
    );
  });

  it("returns undefined when absent or unparseable, so the caller uses its default", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("   ")).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs("-5")).toBeUndefined();
    expect(retryAfterMs("7.5")).toBeUndefined();
  });
});

describe("JSON narrowing helpers", () => {
  it("accepts only plain objects as records", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
  });

  it("treats a missing array as empty rather than throwing", () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray({ results: [] })).toEqual([]);
  });

  it("rejects empty strings, so a blank id never reads as present", () => {
    expect(asString("a")).toBe("a");
    expect(asString("")).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(42)).toBeUndefined();
  });
});
