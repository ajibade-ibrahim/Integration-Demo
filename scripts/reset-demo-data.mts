/**
 * Delete every integration for the demo user, leaving the user in place.
 *   npx tsx scripts/reset-demo-data.mts
 * Cascades remove tokens, mappings, discovery cache, records, and sync runs.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const { count } = await prisma.integration.deleteMany({});
console.log(`Deleted ${count} integration(s).`);
await prisma.$disconnect();
