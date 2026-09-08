/**
 * Password hashing for the credentials login.
 *
 * Uses Node's built-in scrypt rather than bcrypt or argon2. Those are better
 * studied, but both arrive as native modules that have to compile per platform,
 * and this repo runs with four runtime dependencies on purpose. scrypt is
 * memory-hard, ships in the standard library, and is what `node:crypto` offers
 * for exactly this job.
 *
 * The stored format is self-describing — `scrypt$<salt>$<key>`, both base64 —
 * so a later move to argon2 can recognise and re-hash old values on next login
 * instead of locking everyone out.
 *
 * Unrelated to `core/oauth/crypto.ts`, which encrypts provider tokens with
 * AES-256-GCM. That is reversible by design because the tokens have to be
 * replayed to providers; these are one-way and must stay that way.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SCHEME = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Hash a password for storage. Never logs, never returns the input. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = (await scryptAsync(password, salt, KEY_BYTES)) as Buffer;
  return `${SCHEME}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed or unrecognised hash: a
 * corrupt row should fail the login, not the request. Comparison is
 * constant-time, because a byte-by-byte one leaks the expected value to anyone
 * willing to measure — the same reasoning as `safeEqual` in the OAuth crypto.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3) return false;

  const [scheme, saltB64, keyB64] = parts;
  if (scheme !== SCHEME || saltB64 === undefined || keyB64 === undefined) {
    return false;
  }

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;

  // Lengths are equal by construction above, but timingSafeEqual throws rather
  // than returning false when they are not, so the guard stays.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Burn roughly the time a real verification costs.
 *
 * Called when no user matched, so "no such account" and "wrong password" take
 * comparable time. Without it the login endpoint answers faster for unknown
 * addresses, which turns it into a way to enumerate who has an account.
 */
export async function equalizeFailureTiming(): Promise<void> {
  await scryptAsync("dummy", randomBytes(SALT_BYTES), KEY_BYTES);
}
