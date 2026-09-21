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
 *
 * `c-009` to `c-011` are a second group with a different job: they are the same
 * three companies the Stripe and Metrifox fixtures carry, so cross-integration
 * identity resolution has something to resolve. Everything before them is a
 * separate universe by design — mock Acme is `acme-mfg.com` where Metrifox Acme
 * is `acme.example` — and that is left alone rather than retuned, because each
 * of those records is pinned by a test for the branch it exercises.
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

  // --- The converging three ------------------------------------------------
  //
  // Everything above is its own universe: mock Acme is `acme-mfg.com` while
  // Metrifox Acme is `acme.example`, so nothing cross-matches and identity
  // resolution has nothing to demonstrate. These three appear in the Stripe and
  // Metrifox fixtures as well, each arriving by a different route, so the
  // Accounts tab shows one company where the Customers tab shows three rows.
  //
  // Added rather than edited in. The existing entries are pinned by the handler
  // tests and each one exercises a branch; retuning them to converge would cost
  // that coverage to buy this.
  {
    // Joins Metrifox on `ridgeline.example` — a **domain** match, the weaker
    // kind, and the one Stripe can never make because it has no website field.
    // Its name also differs from both others at equal priority, which is what
    // raises the `field_conflict` the Accounts tab explains.
    id: "c-009",
    properties: {
      name: "Ridgeline Utilities Group",
      website: "https://www.ridgeline.example/about",
      industry: "Utilities",
      createdate: "2023-04-12T09:00:00.000Z",
      lifecyclestage: "customer",
      account_tier: "gold",
    },
  },
  {
    // Joins Metrifox on `tessellate.example`. Stripe holds this company too,
    // under a different name on a different domain, and reaches it only
    // through the crosswalk — see `stripe_customer_id` in the Metrifox
    // fixtures.
    id: "c-010",
    properties: {
      name: "Tessellate Laboratories",
      website: "https://tessellate.example",
      industry: "Research",
      createdate: "2024-08-30T15:20:00.000Z",
      lifecyclestage: "customer",
      account_tier: "silver",
    },
  },
  {
    // Not in Metrifox at all. Joins Stripe through a **contact's** address
    // (`p-021` below), which is the universal route: all five providers map
    // `contact.email`, while only two carry an account-level one.
    id: "c-011",
    properties: {
      name: "Halcyon Foods Ltd",
      website: "https://halcyonfoods.example",
      industry: "Food & Beverage",
      createdate: "2025-01-09T11:45:00.000Z",
      lifecyclestage: "customer",
      account_tier: "bronze",
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

  // People at the converging three. `p-021` is the load-bearing one: mock has
  // no account-level email, so this contact's address is the only thing that
  // can join Halcyon to the Stripe customer of the same name.
  { id: "p-021", companyId: "c-011", properties: { firstname: "Bea", lastname: "Halloran", email: "ap@halcyonfoods.example", jobtitle: "Accounts Payable", phone: "+1-206-555-0211" } },
  { id: "p-022", companyId: "c-009", properties: { firstname: "Idris", lastname: "Mwangi", email: "i.mwangi@ridgeline.example", jobtitle: "Grid Operations Manager", phone: "+1-503-555-0212" } },
  { id: "p-023", companyId: "c-010", properties: { firstname: "Wren", lastname: "Kavanagh", email: "w.kavanagh@tessellate.example", jobtitle: "Lab Director", phone: "+44 161 555 0213" } },
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
