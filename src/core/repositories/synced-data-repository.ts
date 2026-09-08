/**
 * Reads over the records the sync engine wrote.
 *
 * Deliberately reports the *unlinked* contact count alongside the rows. A
 * contact whose company could not be resolved is kept rather than dropped, and
 * that decision is only defensible if the consequence is visible — otherwise it
 * is silent data loss wearing a different hat.
 */

import { prisma } from "@/lib/prisma";
import { readJsonObject } from "./json-column";

export interface CustomerRow {
  id: string;
  externalSourceId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  createDate: Date | null;
  type: string | null;
  customFields: Record<string, string>;
  integrationLabel: string;
  providerName: string;
  contactCount: number;
}

export interface ContactRow {
  id: string;
  externalSourceId: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  phone: string | null;
  customerName: string | null;
  /** Provider's own company id, present even when the link is unresolved. */
  externalCustomerId: string | null;
  integrationLabel: string;
}

export interface SyncedDataPage {
  customers: CustomerRow[];
  contacts: ContactRow[];
  totals: {
    customers: number;
    contacts: number;
    /** Contacts that claimed a company we could not resolve. */
    unlinkedContacts: number;
  };
}

export async function loadSyncedData(
  userId: string,
  take = 200
): Promise<SyncedDataPage> {
  const scope = { integration: { userId } };

  const [customers, contacts, customerTotal, contactTotal, unlinked] =
    await Promise.all([
      prisma.customer.findMany({
        where: scope,
        orderBy: { name: "asc" },
        take,
        include: {
          integration: { select: { instanceLabel: true, providerName: true } },
          _count: { select: { contacts: true } },
        },
      }),
      prisma.contact.findMany({
        where: scope,
        orderBy: { name: "asc" },
        take,
        include: {
          integration: { select: { instanceLabel: true } },
          customer: { select: { name: true } },
        },
      }),
      prisma.customer.count({ where: scope }),
      prisma.contact.count({ where: scope }),
      prisma.contact.count({
        where: { ...scope, customerId: null, externalCustomerId: { not: null } },
      }),
    ]);

  return {
    customers: customers.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      domain: row.domain,
      industry: row.industry,
      createDate: row.createDate,
      type: row.type,
      customFields: readJsonObject(row.customFields),
      integrationLabel: row.integration.instanceLabel,
      providerName: row.integration.providerName,
      contactCount: row._count.contacts,
    })),
    contacts: contacts.map((row) => ({
      id: row.id,
      externalSourceId: row.externalSourceId,
      name: row.name,
      email: row.email,
      jobTitle: row.jobTitle,
      phone: row.phone,
      customerName: row.customer?.name ?? null,
      externalCustomerId: row.externalCustomerId,
      integrationLabel: row.integration.instanceLabel,
    })),
    totals: {
      customers: customerTotal,
      contacts: contactTotal,
      unlinkedContacts: unlinked,
    },
  };
}
