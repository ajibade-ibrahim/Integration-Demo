import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  generateState,
  resetEncryptionKeyCache,
  safeEqual,
} from "@/core/oauth/crypto";
import {
  clearStateStore,
  consumeState,
  discardStateFor,
  discardStateForDraft,
  issueState,
  type StateSubject,
} from "@/core/oauth/state-store";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env["TOKEN_ENCRYPTION_KEY"] = VALID_KEY;
  resetEncryptionKeyCache();
  clearStateStore();
});

afterEach(() => {
  process.env["TOKEN_ENCRYPTION_KEY"] = VALID_KEY;
  resetEncryptionKeyCache();
});

describe("token encryption", () => {
  it("round-trips a token", () => {
    const token = "pat-na1-9f3c-secret-value";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it.each([
    ["empty", ""],
    ["unicode", "tökén-ünïcodé-🔐"],
    ["long", "x".repeat(4096)],
    ["dots", "a.b.c.d.e"],
  ])("round-trips a %s value", (_label, token) => {
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("produces different ciphertext each time for the same input", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(decryptToken(b));
  });

  it("never contains the plaintext", () => {
    expect(encryptToken("SUPERSECRET")).not.toContain("SUPERSECRET");
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const encrypted = encryptToken("original");
    const parts = encrypted.split(".");
    const data = Buffer.from(parts[3] as string, "base64url");
    data[0] = (data[0] ?? 0) ^ 0xff;
    parts[3] = data.toString("base64url");

    expect(() => decryptToken(parts.join("."))).toThrow(/authentication/);
  });

  it("rejects a tampered auth tag", () => {
    const parts = encryptToken("original").split(".");
    const tag = Buffer.from(parts[2] as string, "base64url");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString("base64url");

    expect(() => decryptToken(parts.join("."))).toThrow();
  });

  it.each([
    ["too few segments", "v1.abc.def"],
    ["unknown version", "v9.aaaa.bbbb.cccc"],
    ["garbage", "not-encrypted-at-all"],
  ])("rejects %s", (_label, payload) => {
    expect(() => decryptToken(payload)).toThrow();
  });

  it("cannot decrypt with a different key", () => {
    const encrypted = encryptToken("secret");
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64");
    resetEncryptionKeyCache();
    expect(() => decryptToken(encrypted)).toThrow();
  });
});

describe("encryption key validation", () => {
  // The sibling project fell back to a hardcoded dev key with a warning, which
  // silently encrypts production refresh tokens under a key in the source tree.
  it("throws when the key is absent rather than using a fallback", () => {
    delete process.env["TOKEN_ENCRYPTION_KEY"];
    resetEncryptionKeyCache();
    expect(() => encryptToken("x")).toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
  });

  it("throws when the key is empty", () => {
    process.env["TOKEN_ENCRYPTION_KEY"] = "   ";
    resetEncryptionKeyCache();
    expect(() => encryptToken("x")).toThrow(/not set/);
  });

  it("throws when the key is the wrong length", () => {
    process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(16, 1).toString("base64");
    resetEncryptionKeyCache();
    expect(() => encryptToken("x")).toThrow(/must decode to 32 bytes/);
  });
});

describe("safeEqual", () => {
  it.each([
    ["identical", "abc", "abc", true],
    ["different content", "abc", "abd", false],
    ["different length", "abc", "abcd", false],
    ["both empty", "", "", true],
  ])("%s", (_label, a, b, expected) => {
    expect(safeEqual(a, b)).toBe(expected);
  });
});

describe("generateState", () => {
  it("produces at least 16 bytes of entropy", () => {
    expect(Buffer.from(generateState(), "base64url").length).toBeGreaterThanOrEqual(16);
  });

  it("does not repeat across many calls", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateState()));
    expect(seen.size).toBe(500);
  });

  it("is URL-safe", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("state store", () => {
  const forIntegration = (integrationId: string): StateSubject => ({
    kind: "integration",
    integrationId,
  });

  it("accepts the state it issued and reports the subject", () => {
    const state = issueState(forIntegration("int-1"));
    expect(consumeState(state)).toEqual({
      ok: true,
      subject: { kind: "integration", integrationId: "int-1" },
    });
  });

  it("rejects a state it never issued", () => {
    issueState(forIntegration("int-1"));
    const result = consumeState("fabricated-state");
    expect(result.ok).toBe(false);
    expect(result.subject).toBeUndefined();
  });

  // Without single use, a leaked callback URL could be replayed.
  it("refuses to accept the same state twice", () => {
    const state = issueState(forIntegration("int-1"));
    expect(consumeState(state).ok).toBe(true);
    expect(consumeState(state).ok).toBe(false);
  });

  it.each([
    ["null", null],
    ["empty", ""],
  ])("rejects a %s state", (_label, value) => {
    expect(consumeState(value).ok).toBe(false);
  });

  it("rejects an expired state", () => {
    const now = Date.now();
    const state = issueState(forIntegration("int-1"), now);
    // Just past the 30-minute window.
    const result = consumeState(state, now + 30 * 60 * 1000 + 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired|does not match/);
  });

  it("keeps states for different integrations distinct", () => {
    const a = issueState(forIntegration("int-a"));
    const b = issueState(forIntegration("int-b"));
    expect(consumeState(a).subject).toEqual(forIntegration("int-a"));
    expect(consumeState(b).subject).toEqual(forIntegration("int-b"));
  });

  it("discards pending state for a deleted integration", () => {
    const state = issueState(forIntegration("int-1"));
    discardStateFor("int-1");
    expect(consumeState(state).ok).toBe(false);
  });

  // The callback branches on the subject to decide whether to create a row or
  // update one. Confusing the two would either duplicate an integration or
  // re-key an unrelated one, so the kinds must not be interchangeable even when
  // the id strings collide.
  it("distinguishes a draft subject from an integration subject", () => {
    const draftState = issueState({ kind: "draft", draftId: "same-id" });
    const integrationState = issueState(forIntegration("same-id"));

    expect(consumeState(draftState).subject).toEqual({
      kind: "draft",
      draftId: "same-id",
    });
    expect(consumeState(integrationState).subject).toEqual({
      kind: "integration",
      integrationId: "same-id",
    });
  });

  it("discarding an integration's state leaves an identically named draft alone", () => {
    const draftState = issueState({ kind: "draft", draftId: "same-id" });
    discardStateFor("same-id");
    expect(consumeState(draftState).ok).toBe(true);
  });

  it("discards pending state for a draft that has been connected", () => {
    const state = issueState({ kind: "draft", draftId: "draft-1" });
    discardStateForDraft("draft-1");
    expect(consumeState(state).ok).toBe(false);
  });
});
