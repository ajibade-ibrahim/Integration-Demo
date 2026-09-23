/**
 * Chargebee mock API fixtures for testing identity sync and credential validation.
 */

export const CHARGEBEE_FIXTURE_CUSTOMER_1 = {
  id: "cb_cust_acme",
  first_name: "John",
  last_name: "Doe",
  email: "john@acme.com",
  company: "Acme Inc",
  phone: "+1-555-0100",
  created_at: 1672531200, // 2023-01-01T00:00:00.000Z
  billing_address: {
    first_name: "John",
    last_name: "Doe",
    email: "billing@acme.com",
    company: "Acme Inc",
    phone: "+1-555-0100",
    line1: "123 Main St",
    city: "San Francisco",
    state: "CA",
    country: "US",
    zip: "94105",
  },
};

export const CHARGEBEE_FIXTURE_CUSTOMER_2 = {
  id: "cb_cust_globex",
  first_name: "Jane",
  last_name: "Smith",
  email: "jane@globex.com",
  company: "Globex Corporation",
  phone: "+1-555-0200",
  created_at: 1675209600, // 2023-02-01T00:00:00.000Z
  billing_address: {
    first_name: "Jane",
    last_name: "Smith",
    email: "jane@globex.com",
    company: "Globex Corporation",
    phone: "+1-555-0200",
  },
};

export const CHARGEBEE_FIXTURE_CUSTOMERS_PAGE_1 = {
  list: [
    { customer: CHARGEBEE_FIXTURE_CUSTOMER_1 },
    { customer: CHARGEBEE_FIXTURE_CUSTOMER_2 },
  ],
  next_offset: "offset_page_2",
};

export const CHARGEBEE_FIXTURE_CUSTOMERS_PAGE_2 = {
  list: [
    {
      customer: {
        id: "cb_cust_stark",
        first_name: "Tony",
        last_name: "Stark",
        email: "tony@starkindustries.com",
        company: "Stark Industries",
        created_at: 1677628800,
      },
    },
  ],
};
