/**
 * Fixture data for the mock CRM provider.
 *
 * Deliberately shaped like HubSpot's payloads (a nested `properties` object,
 * associations by external id) so the mock exercises the same mapping and
 * association code paths the real providers do.
 *
 * The awkward records are the point — each one exercises a branch that would
 * otherwise only be reachable against a real org:
 *   - `c-007` has no industry            → mapped-but-absent source field → null
 *   - `p-018` has a malformed email      → per-record rejection, run continues
 *   - `p-019` references a missing company → association fallback, kept with a warning
 *   - `p-020` has no company at all       → null association, no warning
 */

export interface MockCompany {
  id: string;
  properties: Record<string, string>;
}

export interface MockPerson {
  id: string;
  properties: Record<string, string>;
  companyId?: string;
}

export const MOCK_COMPANIES: MockCompany[] = [
  {
    id: "c-001",
    properties: {
      name: "Acme Manufacturing",
      website: "https://www.acme-mfg.com/about",
      industry: "Manufacturing",
      createdate: "2024-01-15T09:30:00.000Z",
      lifecyclestage: "customer",
      account_tier: "gold",
    },
  },
  {
    id: "c-002",
    properties: {
      name: "Northwind Logistics",
      website: "http://northwind-logistics.co.uk",
      industry: "Transportation",
      createdate: "2024-03-02T14:05:00.000Z",
      lifecyclestage: "customer",
      account_tier: "silver",
    },
  },
  {
    id: "c-003",
    properties: {
      name: "Belmont Health Group",
      website: "belmonthealth.org",
      industry: "Healthcare",
      createdate: "2024-05-21T08:00:00.000Z",
      lifecyclestage: "prospect",
      account_tier: "bronze",
    },
  },
  {
    id: "c-004",
    properties: {
      name: "Cobalt Financial",
      website: "https://cobaltfinancial.com",
      industry: "Financial Services",
      createdate: "2023-11-08T16:45:00.000Z",
      lifecyclestage: "customer",
      account_tier: "gold",
    },
  },
  {
    id: "c-005",
    properties: {
      name: "Dunmore Retail",
      website: "https://www.dunmore.retail",
      industry: "Retail",
      createdate: "2025-02-11T10:15:00.000Z",
      lifecyclestage: "partner",
      account_tier: "silver",
    },
  },
  {
    id: "c-006",
    properties: {
      name: "Ivory Software",
      website: "https://ivory.software/product",
      industry: "Computer Software",
      createdate: "2025-04-30T12:00:00.000Z",
      lifecyclestage: "prospect",
      account_tier: "bronze",
    },
  },
  {
    // No industry — exercises absent-source-field-becomes-null.
    id: "c-007",
    properties: {
      name: "Palegate Energy",
      website: "https://palegate.energy",
      createdate: "2025-06-18T07:20:00.000Z",
      lifecyclestage: "prospect",
    },
  },
  {
    id: "c-008",
    properties: {
      name: "Verity Consulting",
      website: "https://www.verity-consulting.com/services/",
      industry: "Consulting",
      createdate: "2025-08-05T13:40:00.000Z",
      lifecyclestage: "vendor",
      account_tier: "silver",
    },
  },
];

export const MOCK_PEOPLE: MockPerson[] = [
  { id: "p-001", companyId: "c-001", properties: { firstname: "Dana", lastname: "Whitfield", email: "dana.whitfield@acme-mfg.com", jobtitle: "VP Operations", phone: "+1-415-555-0101" } },
  { id: "p-002", companyId: "c-001", properties: { firstname: "Marcus", lastname: "Oyelaran", email: "marcus.o@acme-mfg.com", jobtitle: "Plant Manager", phone: "+1-415-555-0102" } },
  { id: "p-003", companyId: "c-001", properties: { firstname: "Priya", lastname: "Raghunathan", email: "priya.r@acme-mfg.com", jobtitle: "Procurement Lead", phone: "+1-415-555-0103" } },
  { id: "p-004", companyId: "c-002", properties: { firstname: "Tomasz", lastname: "Kowalczyk", email: "t.kowalczyk@northwind-logistics.co.uk", jobtitle: "Fleet Director", phone: "+44 20 7946 0111" } },
  { id: "p-005", companyId: "c-002", properties: { firstname: "Nadia", lastname: "Bergström", email: "nadia.b@northwind-logistics.co.uk", jobtitle: "Head of Compliance", phone: "+44 20 7946 0112" } },
  { id: "p-006", companyId: "c-003", properties: { firstname: "Ellis", lastname: "Nakamura", email: "e.nakamura@belmonthealth.org", jobtitle: "Chief Medical Officer", phone: "+1-312-555-0144" } },
  { id: "p-007", companyId: "c-003", properties: { firstname: "Rosalind", lastname: "Achebe", email: "r.achebe@belmonthealth.org", jobtitle: "Director of Nursing", phone: "+1-312-555-0145" } },
  { id: "p-008", companyId: "c-004", properties: { firstname: "Gideon", lastname: "Marchetti", email: "g.marchetti@cobaltfinancial.com", jobtitle: "Managing Partner", phone: "+1-212-555-0188" } },
  { id: "p-009", companyId: "c-004", properties: { firstname: "Yuki", lastname: "Tanaka", email: "y.tanaka@cobaltfinancial.com", jobtitle: "Risk Analyst", phone: "+1-212-555-0189" } },
  { id: "p-010", companyId: "c-004", properties: { firstname: "Imani", lastname: "Osei", email: "i.osei@cobaltfinancial.com", jobtitle: "Compliance Officer", phone: "+1-212-555-0190" } },
  { id: "p-011", companyId: "c-005", properties: { firstname: "Bartholomew", lastname: "Quince", email: "b.quince@dunmore.retail", jobtitle: "Store Operations Lead", phone: "+1-503-555-0122" } },
  { id: "p-012", companyId: "c-005", properties: { firstname: "Saoirse", lastname: "Ní Bhriain", email: "saoirse@dunmore.retail", jobtitle: "Merchandising Manager", phone: "+1-503-555-0123" } },
  { id: "p-013", companyId: "c-006", properties: { firstname: "Nikolai", lastname: "Petrov", email: "n.petrov@ivory.software", jobtitle: "Staff Engineer", phone: "+1-206-555-0177" } },
  { id: "p-014", companyId: "c-006", properties: { firstname: "Amara", lastname: "Diallo", email: "a.diallo@ivory.software", jobtitle: "Product Manager", phone: "+1-206-555-0178" } },
  { id: "p-015", companyId: "c-007", properties: { firstname: "Cormac", lastname: "Sullivan", email: "c.sullivan@palegate.energy", jobtitle: "Grid Analyst", phone: "+1-720-555-0166" } },
  { id: "p-016", companyId: "c-008", properties: { firstname: "Hyacinth", lastname: "Okonkwo", email: "h.okonkwo@verity-consulting.com", jobtitle: "Principal Consultant", phone: "+1-617-555-0155" } },
  { id: "p-017", companyId: "c-008", properties: { firstname: "Rafael", lastname: "Ibarra", email: "r.ibarra@verity-consulting.com", jobtitle: "Engagement Lead", phone: "+1-617-555-0156" } },
  {
    // Malformed email — rejected individually; the run must continue.
    id: "p-018",
    companyId: "c-002",
    properties: { firstname: "Bad", lastname: "Address", email: "not-an-email", jobtitle: "Unknown", phone: "" },
  },
  {
    // Points at a company that does not exist — association fallback path.
    id: "p-019",
    companyId: "c-999",
    properties: { firstname: "Orla", lastname: "Fitzgerald", email: "orla.f@example.com", jobtitle: "Consultant", phone: "+353 1 555 0199" } },
  {
    // No company at all — null association, and that is not an error.
    id: "p-020",
    properties: { firstname: "Independent", lastname: "Contractor", email: "solo@freelance.dev", jobtitle: "Freelancer", phone: "" },
  },
];

/** Field definitions the mock exposes through its discovery endpoint. */
export const MOCK_COMPANY_FIELDS = [
  { path: "properties.name", label: "Company name", type: "string" },
  { path: "properties.website", label: "Website URL", type: "string" },
  { path: "properties.industry", label: "Industry", type: "string" },
  { path: "properties.createdate", label: "Created date", type: "datetime" },
  { path: "properties.lifecyclestage", label: "Lifecycle stage", type: "enumeration" },
  { path: "properties.account_tier", label: "Account tier", type: "string" },
  { path: "id", label: "Record ID", type: "string" },
] as const;

export const MOCK_PERSON_FIELDS = [
  { path: "properties.firstname", label: "First name", type: "string" },
  { path: "properties.lastname", label: "Last name", type: "string" },
  { path: "properties.email", label: "Email", type: "string" },
  { path: "properties.jobtitle", label: "Job title", type: "string" },
  { path: "properties.phone", label: "Phone number", type: "string" },
  { path: "id", label: "Record ID", type: "string" },
] as const;

/** Page size, small enough that the fixtures span several pages. */
export const MOCK_PAGE_SIZE = 3;
