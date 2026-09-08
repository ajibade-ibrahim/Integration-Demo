/**
 * Token encryption at rest — AES-256-GCM.
 *
 * There is deliberately no development fallback key. The sibling project
 * defaulted to a hardcoded key with a printed warning, which means a
 * misconfigured deployment encrypts real refresh tokens under a key that is in
 * the source tree, and does so quietly. Failing to start is the safer outcome
 * for a mistake nobody would otherwise notice.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const AUTH_TAG_BYTES = 16;

/** Marks the payload format so a future scheme change stays distinguishable. */
const VERSION = "v1";

let cachedKey: Buffer | undefined;

/**
 * Resolve the encryption key from the environment.
 *
 * @throws If `TOKEN_ENCRYPTION_KEY` is absent or is not 32 bytes once decoded.
 */
export function encryptionKey(): Buffer {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env["TOKEN_ENCRYPTION_KEY"];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('base64'))"`
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "It should be base64 of 32 random bytes."
    );
  }

  cachedKey = key;
  return key;
}

/** Test helper — forces the next call to re-read the environment. */
export function resetEncryptionKeyCache(): void {
  cachedKey = undefined;
}

/**
 * Encrypt a token.
 *
 * @returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. A fresh random IV
 *   per call means encrypting the same token twice yields different output.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a token produced by {@link encryptToken}.
 *
 * @throws If the payload is malformed or fails GCM authentication — a tampered
 *   or truncated ciphertext must not decrypt to anything usable.
 */
export function decryptToken(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new Error("Encrypted token is malformed");
  }

  const [version, ivB64, tagB64, dataB64] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new Error(`Unsupported encrypted token version '${version}'`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Encrypted token has an invalid IV or auth tag");
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately opaque: the caller cannot act on the distinction, and the
    // detail would only help someone probing the ciphertext.
    throw new Error("Encrypted token failed authentication");
  }
}

/**
 * Constant-time string comparison, for the OAuth state parameter.
 *
 * A plain `===` leaks position-of-first-difference through timing. The margin
 * is slim over a network, but the state check is the CSRF defence for the whole
 * authorization flow and the cost of doing it properly is nil.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which is itself an early exit —
  // compare padded copies so only the content comparison is timed.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** A cryptographically random OAuth state value (24 bytes → 192 bits). */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}
