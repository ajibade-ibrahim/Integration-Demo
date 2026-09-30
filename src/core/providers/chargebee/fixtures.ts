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
  ],
};

/** Feature definitions — shaped like a real `/api/v2/features` response. */
export const CHARGEBEE_FIXTURE_FEATURES_PAGE_1 = {
  list: [
    {
      feature: {
        id: "cb_feat_advanced_reports",
        name: "Advanced Reports",
        status: "active",
        type: "switch",
        metered: false,
        levels: [],
        object: "feature",
      },
    },
    {
      feature: {
        id: "cb_feat_dashboards",
        name: "Dashboards",
        status: "active",
        type: "range",
        metered: false,
        unit: "dashboard",
        levels: [
          { name: "Minimum", value: "1", is_unlimited: false, level: 0 },
          { name: "Maximum", value: "50", is_unlimited: false, level: 1 },
        ],
        object: "feature",
      },
    },
  ],
};

/** `/api/v2/features/cb_feat_advanced_reports/item_entitlements` */
export const CHARGEBEE_FIXTURE_ADVANCED_REPORTS_ENTITLEMENTS = {
  list: [
    {
      item_entitlement: {
        id: "item-ent-reports-pro",
        item_id: "cb_item_analytics_pro",
        item_type: "plan",
        feature_id: "cb_feat_advanced_reports",
        feature_name: "Advanced Reports",
        value: "true",
        name: "Available",
        object: "item_entitlement",
      },
    },
  ],
};

/**
 * `/api/v2/features/cb_feat_dashboards/item_entitlements` — the same feature on
 * two items, at two different levels.
 */
export const CHARGEBEE_FIXTURE_DASHBOARDS_ENTITLEMENTS = {
  list: [
    {
      item_entitlement: {
        id: "item-ent-dash-pro",
        item_id: "cb_item_analytics_pro",
        item_type: "plan",
        feature_id: "cb_feat_dashboards",
        feature_name: "Dashboards",
        value: "50",
        name: "Maximum",
        object: "item_entitlement",
      },
    },
    {
      item_entitlement: {
        id: "item-ent-dash-seats",
        item_id: "cb_item_extra_seats",
        item_type: "addon",
        feature_id: "cb_feat_dashboards",
        feature_name: "Dashboards",
        value: "1",
        name: "Minimum",
        object: "item_entitlement",
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

// ---------------------------------------------------------------------------
// Subscriptions (agreements), their effective entitlements, and discounts
// ---------------------------------------------------------------------------

export const CHARGEBEE_FIXTURE_SUBSCRIPTION_1 = {
  id: "cb_sub_acme",
  customer_id: "cb_cust_acme",
  status: "active",
  auto_collection: "on",
  currency_code: "USD",
  billing_period: 1,
  billing_period_unit: "month",
  started_at: 1672531200,
  current_term_start: 1672531200,
  current_term_end: 1675209600,
  next_billing_at: 1675209600,
  trial_start: 1672531200,
  trial_end: 1672617600,
  meta_data: { po: "PO-42" },
  subscription_items: [
    {
      item_price_id: "cb_price_analytics_pro_monthly",
      item_type: "plan",
      quantity: 1,
      unit_price: 9900,
      free_quantity: 0,
      billing_cycles: 1,
      amount: 9900,
    },
    {
      item_price_id: "cb_price_extra_seats",
      item_type: "addon",
      quantity: 5,
      unit_price: 500,
      amount: 2500,
    },
  ],
  discounts: [
    {
      id: "cb_disc_acme_1",
      coupon_id: "cb_coupon_launch",
      invoice_name: "Launch 10% off",
      type: "percentage",
      percentage: 10,
      duration_type: "forever",
      created_at: 1672531200,
    },
  ],
};

export const CHARGEBEE_FIXTURE_SUBSCRIPTION_2 = {
  id: "cb_sub_globex",
  customer_id: "cb_cust_globex",
  status: "non_renewing",
  auto_collection: "off",
  currency_code: "USD",
  billing_period: 1,
  billing_period_unit: "month",
  started_at: 1675209600,
  current_term_start: 1675209600,
  current_term_end: 1677888000,
  cancelled_at: 1677888000,
  subscription_items: [
    {
      item_price_id: "cb_price_analytics_pro_monthly",
      item_type: "plan",
      quantity: 1,
      unit_price: 9900,
      amount: 9900,
    },
  ],
  discounts: [],
};

export const CHARGEBEE_FIXTURE_SUBSCRIPTIONS_PAGE_1 = {
  list: [
    { subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_1 },
    { subscription: CHARGEBEE_FIXTURE_SUBSCRIPTION_2 },
  ],
};

export const CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_1 = {
  list: [
    {
      subscription_entitlement: {
        subscription_id: "cb_sub_acme",
        feature_id: "cb_feat_dashboards",
        feature_name: "Dashboards",
        value: "50",
        name: "Maximum",
        is_overridden: true,
        is_enabled: true,
      },
    },
    {
      subscription_entitlement: {
        subscription_id: "cb_sub_acme",
        feature_id: "cb_feat_advanced_reports",
        feature_name: "Advanced Reports",
        value: "false",
        name: "Enabled",
        is_overridden: false,
        is_enabled: false,
      },
    },
  ],
};

export const CHARGEBEE_FIXTURE_SUBSCRIPTION_ENTITLEMENTS_EMPTY = {
  list: [],
};
