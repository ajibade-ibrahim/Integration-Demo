/** Show what a sync produced.  npx tsx scripts/inspect-synced.mts <integrationId> */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const integrationId = process.argv[2]!;

const customers = await prisma.customer.findMany({
  where: { integrationId },
  orderBy: { externalSourceId: "asc" },
  include: { contacts: { select: { id: true } } },
});

console.log(`CUSTOMERS (${customers.length})`);
console.log("ext     name                    domain                 industry          type       contacts  custom");
for (const c of customers) {
  console.log(
    [
      c.externalSourceId.padEnd(7),
      c.name.slice(0, 22).padEnd(23),
      (c.domain ?? "—").padEnd(22),
      (c.industry ?? "—").slice(0, 16).padEnd(17),
      (c.type ?? "—").padEnd(10),
      String(c.contacts.length).padEnd(9),
      c.customFields === "{}" ? "—" : c.customFields,
    ].join(" ")
  );
}

const contacts = await prisma.contact.findMany({
  where: { integrationId },
  orderBy: { externalSourceId: "asc" },
  include: { customer: { select: { externalSourceId: true } } },
});

console.log(`\nCONTACTS (${contacts.length})`);
console.log("ext     name           email                              linked to  extCustomerId");
for (const c of contacts) {
  console.log(
    [
      c.externalSourceId.padEnd(7),
      c.name.slice(0, 13).padEnd(14),
      (c.email ?? "—").slice(0, 34).padEnd(35),
      (c.customer?.externalSourceId ?? "—").padEnd(10),
      c.externalCustomerId ?? "—",
    ].join(" ")
  );
}

const linked = contacts.filter((c) => c.customerId !== null).length;
console.log(`\nlinked: ${linked}/${contacts.length}`);

await prisma.$disconnect();
