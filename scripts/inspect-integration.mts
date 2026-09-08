/**
 * Inspect one integration and its stored token.
 *   npx tsx scripts/inspect-integration.mts <integrationId>
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const id = process.argv[2];

if (id === undefined) {
  console.error("Usage: npx tsx scripts/inspect-integration.mts <integrationId>");
  process.exit(1);
}

const integration = await prisma.integration.findUnique({
  where: { id },
  include: { functions: true, token: true },
});

if (integration === null) {
  console.error(`No integration ${id}`);
  process.exit(1);
}

const token = integration.token;
console.log("status:           ", integration.status);
console.log("authorizedAt:     ", integration.authorizationTimestamp?.toISOString() ?? "—");
console.log("functions:        ", integration.functions.map((f) => f.functionName).join(", "));
console.log("grantedScopes:    ", token?.grantedScopes ?? "—");
console.log("token expiresAt:  ", token?.expiresAt.toISOString() ?? "—");
console.log("accessTokenEnc:   ", token === null ? "—" : token.accessTokenEnc.slice(0, 32) + "…");
console.log("refreshToken set: ", token !== null && token.refreshTokenEnc !== null);
console.log("providerMetadata: ", token?.providerMetadata ?? "—");
console.log("plaintext leaked: ", token !== null && token.accessTokenEnc.includes("mock-at"));

await prisma.$disconnect();
