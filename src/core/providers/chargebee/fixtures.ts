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

export const CHARGEBEE_FIXTURE_ITEM_FAMILIES_PAGE_1 = {
  list: [
    {
      item_family: {
        id: "cb_family_analytics",
        name: "Analytics Suite",
        description: "Suite for analytics products",
        status: "active",
        created_at: 1672531200,
      },
    },
  ],
};

export const CHARGEBEE_FIXTURE_ITEMS_PAGE_1 = {
  list: [
    {
      item: {
        id: "cb_item_analytics_pro",
        name: "Analytics Pro Plan",
        description: "Pro plan for analytics",
        type: "plan",
        item_family_id: "cb_family_analytics",
        status: "active",
        created_at: 1672531200,
      },
    },
    {
      item: {
        id: "cb_item_extra_seats",
        name: "Extra Seats Addon",
        type: "addon",
        item_family_id: "cb_family_analytics",
        status: "active",
        created_at: 1672531200,
      },
    },
    {
      item: {
        id: "cb_item_advanced_reports",
        name: "Advanced Reports",
        type: "feature",
        item_family_id: "cb_family_analytics",
        status: "active",
        created_at: 1672531200,
      },
    },
  ],
};

export const CHARGEBEE_FIXTURE_ITEM_PRICES_PAGE_1 = {
  list: [
    {
      item_price: {
        id: "cb_price_analytics_pro_monthly",
        name: "Analytics Pro Monthly",
        item_id: "cb_item_analytics_pro",
        price: 9900,
        currency_code: "USD",
        period: 1,
        period_unit: "month",
        status: "active",
        created_at: 1672531200,
      },
    },
    {
      item_price: {
        id: "cb_price_analytics_pro_yearly",
        name: "Analytics Pro Yearly",
        item_id: "cb_item_analytics_pro",
        price: 99000,
        currency_code: "USD",
        period: 1,
        period_unit: "year",
        status: "active",
        created_at: 1672531200,
      },
    },
  ],
};
