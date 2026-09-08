/**
 * Token persistence. The only module that reads or writes plaintext tokens.
 *
 * Nothing here logs a token value, and no API route returns one. Callers
 * reference tokens by integration id.
 */

import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "../oauth/crypto";
import {
  readJsonObject,
  readScopeList,
  writeJsonObject,
  writeScopeList,
} from "./json-column";
import type { ProviderMetadata } from "../types/registry";

export interface StoredToken {
  integrationId: string;
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: Date;
  grantedScopes: string[];
  metadata: ProviderMetadata;
}

/**
 * Expiry stamped on a credential that does not expire.
 *
 * `expiresAt` is non-null in the schema and every consumer does date maths on
 * it, so a null would mean both a migration and a nullable branch everywhere.
 * A date far enough out that the leeway check can never fire costs neither.
 * Callers should still prefer {@link isNonExpiring} over comparing to this.
 */
export const NON_EXPIRING_AT = new Date("9999-12-31T23:59:59.000Z");

/**
 * Whether this credential is one that is never refreshed.
 *
 * Reads the metadata rather than the date, so a corrupted `expiresAt` still
 * cannot send an API key down the refresh path.
 */
export function isNonExpiring(token: StoredToken): boolean {
  return token.metadata["authKind"] === "apiKey";
}

export interface SaveTokenInput {
  integrationId: string;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: Date;
  grantedScopes: readonly string[];
  metadata: ProviderMetadata;
}

/**
 * Insert or replace the token for an integration.
 *
 * A refresh response often omits `refresh_token`, meaning "keep using the one
 * you have". Passing undefined preserves the stored value rather than wiping
 * it — dropping it would silently make the integration unrefreshable.
 */
export async function saveToken(input: SaveTokenInput): Promise<void> {
  const accessTokenEnc = encryptToken(input.accessToken);
  const refreshTokenEnc =
    input.refreshToken === undefined ? undefined : encryptToken(input.refreshToken);

  const common = {
    accessTokenEnc,
    expiresAt: input.expiresAt,
    grantedScopes: writeScopeList(input.grantedScopes),
    providerMetadata: writeJsonObject(input.metadata),
  };

  await prisma.oAuthToken.upsert({
    where: { integrationId: input.integrationId },
    create: {
      integrationId: input.integrationId,
      ...common,
      refreshTokenEnc: refreshTokenEnc ?? null,
    },
    update: {
      ...common,
      // Only overwrite the refresh token when a new one was actually issued.
      ...(refreshTokenEnc === undefined ? {} : { refreshTokenEnc }),
    },
  });
}

/**
 * Load and decrypt the token for an integration.
 *
 * @returns undefined when no token is stored, or when the stored ciphertext
 *   cannot be decrypted — a rotated `TOKEN_ENCRYPTION_KEY` leaves rows that are
 *   unreadable but harmless, and the integration simply needs reconnecting.
 */
export async function findToken(
  integrationId: string
): Promise<StoredToken | undefined> {
  const row = await prisma.oAuthToken.findUnique({ where: { integrationId } });
  if (row === null) return undefined;

  try {
    return {
      integrationId: row.integrationId,
      accessToken: decryptToken(row.accessTokenEnc),
      refreshToken:
        row.refreshTokenEnc === null ? undefined : decryptToken(row.refreshTokenEnc),
      expiresAt: row.expiresAt,
      grantedScopes: readScopeList(row.grantedScopes),
      metadata: readJsonObject(row.providerMetadata),
    };
  } catch {
    // Deliberately no token material in the message.
    console.error(
      `[token-repository] Stored token for integration ${integrationId} could not be decrypted; reconnection required`
    );
    return undefined;
  }
}

/** Scopes granted to an integration, without decrypting anything. */
export async function findGrantedScopes(
  integrationId: string
): Promise<string[]> {
  const row = await prisma.oAuthToken.findUnique({
    where: { integrationId },
    select: { grantedScopes: true },
  });
  return row === null ? [] : readScopeList(row.grantedScopes);
}

export async function deleteToken(integrationId: string): Promise<void> {
  await prisma.oAuthToken.deleteMany({ where: { integrationId } });
}
