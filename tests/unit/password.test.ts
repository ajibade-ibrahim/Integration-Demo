/**
 * Password hashing.
 *
 * The properties that matter are the ones whose absence is silent: a hash that
 * verifies against the wrong password, or a malformed stored value that throws
 * instead of failing the login. Neither shows up in a happy-path login test.
 */

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/password";

describe("hashPassword", () => {
  it("verifies the password it was given", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a different password", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
  });

  it("salts, so equal passwords do not produce equal hashes", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");

    // Without a per-hash salt these would match, and identical hashes in the
    // table would advertise which accounts share a password.
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("does not store the password", async () => {
    const hash = await hashPassword("plaintext-canary");

    expect(hash).not.toContain("plaintext-canary");
  });

  it("is self-describing, so a later scheme change can migrate", async () => {
    expect(await hashPassword("x")).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });
});

describe("verifyPassword on a malformed hash", () => {
  // A corrupt or hand-edited row must fail the login, not the request. Throwing
  // here would surface as a 500 on the sign-in form, which reads as an outage
  // rather than a bad password.
  it.each([
    ["empty", ""],
    ["no delimiters", "notahash"],
    ["too few parts", "scrypt$onlysalt"],
    ["too many parts", "scrypt$a$b$c"],
    ["unknown scheme", "bcrypt$c2FsdA==$a2V5"],
    ["empty salt", "scrypt$$a2V5"],
    ["empty key", "scrypt$c2FsdA==$"],
  ])("returns false for %s", async (_label, stored) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });
});
