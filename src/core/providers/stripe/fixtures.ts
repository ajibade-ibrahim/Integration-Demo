/**
 * Stripe's static field definitions for the mapping editor.
 *
 * Unlike the mock and Metrifox modules of the same name, there is no fixture
 * *data* here. Stripe's demo data lives in `scripts/stripe-sandbox-fixtures.json`
 * and is created in a real sandbox by the Stripe CLI, so there is nothing for an
 * in-app fake to serve.
 *
 * Stripe publishes no describe or schema endpoint, so the fixed part of the
 * schema is declared here. Discovery unions this with the `metadata.*` keys it
 * samples from live data — see discovery.ts.
 */

import type { DiscoveredFieldDef } from "../../types/registry";

export const STRIPE_CUSTOMER_FIELDS: DiscoveredFieldDef[] = [
  { path: "id", label: "Customer ID", type: "string" },
  { path: "name", label: "Name", type: "string" },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "description", label: "Description", type: "string" },
  {
    path: "created_at",
    label: "Created at (ISO 8601, synthesized from created)",
    type: "datetime",
  },
  // Offered, but labelled, rather than hidden. A user who reaches for the field
  // named in Stripe's own docs would otherwise map it, see an empty Create date
  // column, and have nothing to explain it: epoch seconds do not survive the
  // record writer's date parse.
  {
    path: "created",
    label: "Created (Unix epoch seconds — map created_at instead)",
    type: "number",
  },
  { path: "currency", label: "Currency", type: "string" },
  { path: "balance", label: "Account balance", type: "number" },
  { path: "delinquent", label: "Delinquent", type: "boolean" },
  { path: "invoice_prefix", label: "Invoice prefix", type: "string" },
  { path: "tax_exempt", label: "Tax exempt", type: "string" },
  { path: "address.city", label: "Address — city", type: "string" },
  { path: "address.state", label: "Address — state", type: "string" },
  { path: "address.postal_code", label: "Address — postal code", type: "string" },
  { path: "address.country", label: "Address — country", type: "string" },
];

/**
 * Contacts are entirely synthesized — Stripe has no contact resource — so every
 * path here is one this codebase invents. Labelled as such, so nobody hunts for
 * them in the Stripe API reference.
 */
export const STRIPE_CONTACT_FIELDS: DiscoveredFieldDef[] = [
  { path: "contact_id", label: "Contact ID (synthesized)", type: "string" },
  {
    path: "contact_name",
    label: "Contact name (customer name, or the email local part)",
    type: "string",
  },
  { path: "email", label: "Email", type: "string" },
  { path: "phone", label: "Phone", type: "string" },
  { path: "customer_id", label: "Customer ID (association)", type: "string" },
  { path: "customer_name", label: "Customer name", type: "string" },
];
