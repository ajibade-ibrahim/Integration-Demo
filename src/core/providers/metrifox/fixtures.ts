/**
 * Metrifox fixture data and static field definitions.
 *
 * Shared by the in-app fake (`/api/fake/metrifox`) and the tests, so what the
 * demo shows and what the tests assert on cannot drift apart.
 *
 * Following the mock provider's principle: the awkward records are the point.
 * Several of these are here specifically to be rejected or warned about, so the
 * per-record issue reporting has something honest to report.
 */

import type { DiscoveredFieldDef } from "../../types/registry";

export interface MetrifoxContactPerson {
  is_primary: boolean;
  first_name: string;
  last_name: string;
  email_address: string | null;
  designation: string | null;
  department: string | null;
  phone_number: string | null;
}

export interface MetrifoxCustomer {
  id: string;
  customer_key: string;
  display_name: string;
  legal_name: string;
  customer_type: "BUSINESS" | "INDIVIDUAL";
  primary_email: string | null;
  primary_phone: string | null;
  website_url: string | null;
  currency: string;
  timezone: string;
  country: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  contact_people: MetrifoxContactPerson[];

  /**
   * This company's id in Stripe — the `payments_stripe_customers` join, as a
   * field on the customer.
   *
   * Optional so that adding it left every existing fixture literally
   * untouched, and because the real Metrifox API does not serve it: the spec
   * names the table but documents no field shape, and no endpoint exposes it.
   * It is here to make the `crossRef.stripe` mapping demonstrable end to end;
   * the crosswalk import is the route for a tenant whose API does not carry it.
   *
   * A Stripe sandbox assigns `cus_...` ids at creation time, so the value below
   * is a placeholder and cannot be anything else. Set `METRIFOX_FAKE_STRIPE_IDS`
   * to point it at a sandbox you have actually seeded — see the fake's route.
   */
  stripe_customer_id?: string | null;
}

/**
 * What `stripe_customer_id` says until a real sandbox id replaces it.
 *
 * Deliberately not a plausible-looking id. It reaches the resolver as an
 * `external_ref` key like any other, matches nothing, and joins nothing — which
 * is the correct behaviour for an unconfigured demo, and visible in the
 * Accounts tab's key list rather than silent.
 */
export const METRIFOX_STRIPE_ID_PLACEHOLDER = "cus_SET_METRIFOX_FAKE_STRIPE_IDS";

/**
 * Ten customers, so `per_page=3` spans four pages with a ragged last one.
 *
 * The first eight are the awkward ones; the last two converge with the mock and
 * Stripe fixtures so identity resolution has something to join.
 */
export const METRIFOX_CUSTOMERS: MetrifoxCustomer[] = [
  {
    id: "3f1a9c2e-0d47-4b81-9a55-1c7e2b4d8f60",
    customer_key: "ACME-001",
    display_name: "Acme Manufacturing",
    legal_name: "Acme Manufacturing Holdings Ltd",
    customer_type: "BUSINESS",
    primary_email: "billing@acme.example",
    primary_phone: "+1 415 555 0101",
    website_url: "https://www.acme.example/pricing",
    currency: "USD",
    timezone: "America/Los_Angeles",
    country: "US",
    created_at: "2024-03-11T09:14:00.000Z",
    updated_at: "2026-01-08T11:02:00.000Z",
    metadata: { arr_band: "enterprise", csm_owner: "r.okafor" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Dana",
        last_name: "Whitfield",
        email_address: "dana.whitfield@acme.example",
        designation: "VP Operations",
        department: "Operations",
        phone_number: "+1 415 555 0102",
      },
      {
        is_primary: false,
        first_name: "Marcus",
        last_name: "Ellery",
        email_address: "ap@acme.example",
        designation: "Accounts Payable",
        department: "Finance",
        phone_number: null,
      },
      {
        // Shares the AP mailbox with Marcus above. The slot-collision path:
        // Marcus keeps the clean id, this one gets the index suffix.
        is_primary: false,
        first_name: "Priya",
        last_name: "Raman",
        email_address: "ap@acme.example",
        designation: "Financial Controller",
        department: "Finance",
        phone_number: "+1 415 555 0103",
      },
    ],
  },
  {
    id: "8c4b17d3-5e29-4f60-b3a8-6d90e1f27a4b",
    customer_key: "NORTHWIND-002",
    display_name: "Northwind Freight",
    legal_name: "Northwind Freight GmbH",
    customer_type: "BUSINESS",
    primary_email: "accounts@northwind.example",
    primary_phone: "+49 30 555 0110",
    website_url: "https://northwind.example",
    currency: "EUR",
    timezone: "Europe/Berlin",
    country: "DE",
    created_at: "2023-11-02T14:30:00.000Z",
    updated_at: "2026-02-19T08:45:00.000Z",
    metadata: { arr_band: "mid-market", renewal_quarter: "Q3" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Ingrid",
        last_name: "Sørensen",
        email_address: "ingrid.sorensen@northwind.example",
        designation: "Logistics Director",
        department: "Logistics",
        phone_number: "+49 30 555 0111",
      },
    ],
  },
  {
    id: "b207e6f1-9a34-42dd-8c15-7f3b0d5e91c8",
    customer_key: "HARBOUR-003",
    display_name: "Harbour Analytics",
    legal_name: "Harbour Analytics Pty Ltd",
    customer_type: "BUSINESS",
    primary_email: "hello@harbour.example",
    primary_phone: null,
    // No website: `domain` maps to null rather than failing the record.
    website_url: null,
    currency: "AUD",
    timezone: "Australia/Sydney",
    country: "AU",
    created_at: "2025-06-23T22:05:00.000Z",
    updated_at: "2026-02-01T03:12:00.000Z",
    metadata: { arr_band: "growth" },
    contact_people: [
      {
        // No email, but a name — exercises the name-slot branch of the id.
        is_primary: true,
        first_name: "Tobias",
        last_name: "Lund",
        email_address: null,
        designation: "Head of Data",
        department: "Engineering",
        phone_number: "+61 2 5550 0120",
      },
      {
        // Malformed email — rejected by the record writer, run continues.
        is_primary: false,
        first_name: "Sasha",
        last_name: "Brenner",
        email_address: "sasha.brenner@harbour",
        designation: "Analyst",
        department: "Engineering",
        phone_number: null,
      },
    ],
  },
  {
    id: "d59f8340-2c6b-4e77-a018-4be2c93f5d17",
    customer_key: "SOLO-004",
    // An individual, not a company. `customer_type` is deliberately not mapped
    // to our `type` enum — see defaults.ts.
    display_name: "Rowan Vance",
    legal_name: "Rowan Vance",
    customer_type: "INDIVIDUAL",
    primary_email: "rowan@vance.example",
    primary_phone: "+44 20 5550 0130",
    website_url: "https://vance.example/about",
    currency: "GBP",
    timezone: "Europe/London",
    country: "GB",
    created_at: "2025-09-30T16:48:00.000Z",
    updated_at: "2026-01-27T10:20:00.000Z",
    metadata: {},
    contact_people: [],
  },
  {
    id: "0a6c4e88-7b19-4a23-9f52-e8d1c07b3629",
    customer_key: "MERIDIAN-005",
    // Empty display name — rejected with "Name is required", visibly, rather
    // than silently substituting the legal name.
    display_name: "",
    legal_name: "Meridian Test Fixtures Inc",
    customer_type: "BUSINESS",
    primary_email: null,
    primary_phone: null,
    website_url: "https://meridian.example",
    currency: "USD",
    timezone: "America/New_York",
    country: "US",
    created_at: "2026-01-05T12:00:00.000Z",
    updated_at: "2026-01-05T12:00:00.000Z",
    metadata: { arr_band: "trial" },
    contact_people: [
      {
        // Neither first nor last name: `full_name` is empty, so the contact is
        // rejected for a missing name.
        is_primary: true,
        first_name: "",
        last_name: "",
        email_address: "unknown@meridian.example",
        designation: null,
        department: null,
        phone_number: null,
      },
    ],
  },
  {
    id: "6e83b12f-4d0a-4c95-8710-9a2f6be5d4c1",
    customer_key: "CEDAR-006",
    display_name: "Cedar & Pike LLP",
    legal_name: "Cedar and Pike Limited Liability Partnership",
    customer_type: "BUSINESS",
    primary_email: "practice@cedarpike.example",
    primary_phone: "+1 617 555 0140",
    website_url: "http://cedarpike.example/",
    currency: "USD",
    timezone: "America/New_York",
    country: "US",
    created_at: "2022-07-19T08:00:00.000Z",
    updated_at: "2026-02-22T17:33:00.000Z",
    metadata: { arr_band: "enterprise", csm_owner: "l.mbeki" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Amara",
        last_name: "Osei",
        email_address: "amara.osei@cedarpike.example",
        designation: "Managing Partner",
        department: "Practice",
        phone_number: "+1 617 555 0141",
      },
    ],
  },
  {
    id: "f1c70d5b-3e64-49a8-b2d6-5c8091ae7f32",
    customer_key: "QUANTA-007",
    display_name: "Quanta Renewables",
    legal_name: "Quanta Renewables S.A.",
    customer_type: "BUSINESS",
    primary_email: "finance@quanta.example",
    primary_phone: "+34 91 555 0150",
    website_url: "https://quanta.example",
    currency: "EUR",
    timezone: "Europe/Madrid",
    country: "ES",
    created_at: "2024-12-14T11:25:00.000Z",
    updated_at: "2026-02-11T09:07:00.000Z",
    metadata: { arr_band: "mid-market" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Elena",
        last_name: "Ferrer",
        email_address: "elena.ferrer@quanta.example",
        designation: "CFO",
        department: "Finance",
        phone_number: "+34 91 555 0151",
      },
      {
        is_primary: false,
        first_name: "Bruno",
        last_name: "Castell",
        email_address: "bruno.castell@quanta.example",
        designation: "Procurement Lead",
        department: "Operations",
        phone_number: null,
      },
    ],
  },
  {
    id: "27d4a9e0-8f13-4b6c-a95e-310b7c2d846f",
    customer_key: "LATTICE-008",
    display_name: "Lattice Robotics",
    legal_name: "Lattice Robotics KK",
    customer_type: "BUSINESS",
    primary_email: "keiri@lattice.example",
    primary_phone: "+81 3 5550 0160",
    website_url: "https://www.lattice.example/en",
    currency: "JPY",
    timezone: "Asia/Tokyo",
    country: "JP",
    created_at: "2025-02-08T01:40:00.000Z",
    updated_at: "2026-02-28T05:55:00.000Z",
    metadata: { arr_band: "growth", renewal_quarter: "Q1" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Haruki",
        last_name: "Tanabe",
        email_address: "haruki.tanabe@lattice.example",
        designation: "Engineering Manager",
        department: "R&D",
        phone_number: "+81 3 5550 0161",
      },
    ],
  },

  // --- The converging two --------------------------------------------------
  //
  // The eight above are their own universe and stay that way; each is pinned by
  // a test for the branch it exercises. These two also exist in the mock and
  // Stripe fixtures, so there is something for identity resolution to resolve.
  {
    // Reached three ways at once, which is the point of it: Stripe by a shared
    // **email**, the mock CRM by a shared **domain**, and each source calls the
    // company something slightly different — so the account also demonstrates
    // per-field survivorship and the equal-priority `field_conflict`.
    id: "5b8e0f14-6a72-4c39-9d1b-2e47a0c58d93",
    customer_key: "RIDGELINE-009",
    display_name: "Ridgeline Utilities",
    legal_name: "Ridgeline Utilities Corporation",
    customer_type: "BUSINESS",
    primary_email: "billing@ridgeline.example",
    primary_phone: "+1 503 555 0210",
    website_url: "https://www.ridgeline.example/about",
    currency: "USD",
    timezone: "America/Los_Angeles",
    country: "US",
    // Earlier than either other source has it, which is what `createDate`'s
    // `earliest` conflict policy exists for: the company demonstrably existed
    // in 2021 whichever system ranks highest.
    created_at: "2021-10-04T08:30:00.000Z",
    updated_at: "2026-02-25T13:10:00.000Z",
    metadata: { arr_band: "enterprise", csm_owner: "d.kimura" },
    contact_people: [
      {
        is_primary: true,
        first_name: "Nora",
        last_name: "Ridgeway",
        email_address: "nora.ridgeway@ridgeline.example",
        designation: "Head of Procurement",
        department: "Operations",
        phone_number: "+1 503 555 0211",
      },
    ],
  },
  {
    // The `payments_stripe_customers` case, and the only one that matters for
    // `crossRef`: its Stripe counterpart is on a different domain under a
    // different address, so **no email or domain key can reach it**. The
    // crosswalk id is the entire join.
    id: "9d3c7a26-1f58-4e02-b86d-4c1907f3e5ba",
    customer_key: "TESSELLATE-010",
    display_name: "Tessellate Labs",
    legal_name: "Tessellate Laboratories Limited",
    customer_type: "BUSINESS",
    primary_email: "ap@tessellate.example",
    primary_phone: "+44 161 555 0220",
    website_url: "https://tessellate.example",
    currency: "GBP",
    timezone: "Europe/London",
    country: "GB",
    created_at: "2024-08-30T15:20:00.000Z",
    updated_at: "2026-02-27T09:05:00.000Z",
    metadata: { arr_band: "growth" },
    stripe_customer_id: METRIFOX_STRIPE_ID_PLACEHOLDER,
    contact_people: [
      {
        is_primary: true,
        first_name: "Wren",
        last_name: "Kavanagh",
        email_address: "w.kavanagh@tessellate.example",
        designation: "Lab Director",
        department: "Research",
        phone_number: "+44 161 555 0221",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Field definitions for the mapping editor
// ---------------------------------------------------------------------------

/**
 * Metrifox publishes no describe/schema endpoint, so the fixed part of the
 * schema is declared here. Discovery unions this with the `metadata.*` keys it
 * samples from live data — see discovery.ts.
 */
export const METRIFOX_CUSTOMER_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "customer_key", label: "Customer key", type: "string" },
  { path: "display_name", label: "Display name", type: "string" },
  { path: "legal_name", label: "Legal name", type: "string" },
  { path: "customer_type", label: "Customer type (BUSINESS/INDIVIDUAL)", type: "string" },
  { path: "primary_email", label: "Primary email", type: "string" },
  { path: "primary_phone", label: "Primary phone", type: "string" },
  { path: "website_url", label: "Website URL", type: "string" },
  { path: "currency", label: "Currency", type: "string" },
  { path: "timezone", label: "Time zone", type: "string" },
  { path: "country", label: "Country", type: "string" },
  { path: "created_at", label: "Created at", type: "datetime" },
  { path: "updated_at", label: "Updated at", type: "datetime" },
  // Offered so the crosswalk mapping is reachable from the editor. Absent from
  // most records, which maps to no cross-reference rather than to an error.
  { path: "stripe_customer_id", label: "Stripe customer ID (crosswalk)", type: "string" },
];

export const METRIFOX_CONTACT_FIELDS: DiscoveredFieldDef[] = [
  // The synthesized ones are labelled as such, so nobody hunts for them in the
  // Metrifox API docs.
  { path: "contact_id", label: "Contact ID (synthesized)", type: "string" },
  { path: "full_name", label: "Full name (first + last, synthesized)", type: "string" },
  { path: "first_name", label: "First name", type: "string" },
  { path: "last_name", label: "Last name", type: "string" },
  { path: "email_address", label: "Email address", type: "string" },
  { path: "designation", label: "Designation", type: "string" },
  { path: "department", label: "Department", type: "string" },
  { path: "phone_number", label: "Phone number", type: "string" },
  { path: "is_primary", label: "Is primary contact", type: "boolean" },
  { path: "customer_id", label: "Customer ID (association)", type: "string" },
  { path: "customer_key", label: "Customer key", type: "string" },
];
