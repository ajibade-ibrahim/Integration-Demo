import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const integrations = await db.integration.findMany({
  where: { providerName: "chargebee" },
  include: {
    functions: { select: { functionName: true } },
    _count: { select: { products: true, offerings: true, prices: true } },
  },
  orderBy: { createdAt: "asc" },
});

if (integrations.length === 0) {
  console.log("No Chargebee integration found.");
  await db.$disconnect();
  process.exit(0);
}

for (const i of integrations) {
  console.log(`\nIntegration: ${i.instanceLabel} (${i.id})`);
  console.log(`  status: ${i.status}`);
  console.log(`  functions: ${i.functions.map((f) => f.functionName).join(", ")}`);
  console.log(`  counts:`, i._count);

  const prices = await db.price.findMany({
    where: { integrationId: i.id },
    select: {
      id: true,
      name: true,
      amountMinor: true,
      currency: true,
      interval: true,
      intervalCount: true,
      externalSourceId: true,
      offeringId: true,
      externalOfferingId: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });

  console.log(`\n  Prices (${prices.length}):`);
  for (const p of prices) {
    const linked = p.offeringId ? "linked" : `UNLINKED (ext: ${p.externalOfferingId ?? "null"})`;
    console.log(`    ${p.externalSourceId}  "${p.name}"  ${p.amountMinor ?? "null"} ${p.currency ?? ""}  ${p.interval ?? ""}${p.intervalCount && p.intervalCount > 1 ? `×${p.intervalCount}` : ""}  ${linked}`);
  }
}

await db.$disconnect();
