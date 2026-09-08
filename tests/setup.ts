/**
 * Vitest global setup.
 *
 * Sets the env vars that core modules read at import time so unit and property
 * tests never depend on a developer's local .env.
 */

// Deterministic 32-byte key for AES-256-GCM in tests.
process.env["TOKEN_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");

// Point every test at the throwaway database built by global-setup, never at
// the developer's own. Most tests never touch it; the ones that do truncate
// freely, which is only safe because of this line.
process.env["DATABASE_URL"] = "file:./test.db";

process.env["APP_BASE_URL"] ??= "http://localhost:3000";
process.env["ENABLE_MOCK_PROVIDER"] = "true";

/*
 * Pin the Metrifox base, and pin it by assignment rather than `??=`.
 *
 * Vitest does not load `.env` — but instantiating `PrismaClient` does, so any
 * test that touches the database pulls the developer's `.env` into
 * `process.env` as a side effect, after this file has already run. A developer
 * pointing `METRIFOX_API_BASE` at staging would then silently redirect every
 * mocked Metrifox request, and the msw handlers registered against
 * `api.metrifox.com` would stop matching.
 *
 * Setting these here still wins, because dotenv does not overwrite variables
 * that are already present. Assigning unconditionally is the load-bearing part:
 * `??=` would leave a value that Prisma is about to import untouched.
 */
process.env["METRIFOX_API_BASE"] = "https://api.metrifox.com";
process.env["ENABLE_METRIFOX_FAKE"] = "false";
delete process.env["METRIFOX_PAGE_SIZE"];

// Same hazard, same remedy, for Stripe. The API version is pinned too: the msw
// handlers assert the header, and a developer pinning a different version in
// `.env` would otherwise break tests that have nothing to do with their change.
process.env["STRIPE_API_BASE"] = "https://api.stripe.com";
process.env["STRIPE_API_VERSION"] = "2026-08-26.dahlia";
// Deleted rather than assigned, as above: tests set it per case and clear it in
// `afterEach`, so a value here would mask a regression in `stripePageSize()`'s
// own default.
delete process.env["STRIPE_PAGE_SIZE"];

process.env["HUBSPOT_CLIENT_ID"] ??= "test-hubspot-client-id";
process.env["HUBSPOT_CLIENT_SECRET"] ??= "test-hubspot-client-secret";
process.env["SALESFORCE_CLIENT_ID"] ??= "test-salesforce-client-id";
process.env["SALESFORCE_CLIENT_SECRET"] ??= "test-salesforce-client-secret";
process.env["SALESFORCE_LOGIN_HOST"] ??= "login.salesforce.com";
process.env["SALESFORCE_API_VERSION"] ??= "v60.0";

// Tests use a fake clock, but keep these small in case a real sleep leaks through.
process.env["SYNC_RETRY_DELAY_MS"] = "1";
process.env["RATE_LIMIT_FALLBACK_MS"] = "1";

process.env["MOCK_CLIENT_ID"] ??= "mock-client-id";
process.env["MOCK_CLIENT_SECRET"] ??= "mock-client-secret";
