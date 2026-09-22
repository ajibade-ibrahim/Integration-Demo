/**
 * Runs the real Stripe handlers against the real sandbox and reports what each
 * branch produced.
 *
 * Not a test — it needs a live key and a seeded sandbox, so it cannot run in
 * CI. It exists because the fixtures in `stripe-sandbox-fixtures.json` are
 * chosen to drive *specific* branches (name synthesis fallbacks, the status
 * map, multi-item, zero-decimal currency, a feature shared by two products),
 * and nothing else checks that they still do. Edit a fixture's price and the branch it was covering can go quiet
 * without any suite noticing.
 *
 * Reads no database and writes nothing anywhere.
 *
 *   node --import tsx scripts/verify-stripe-fixtures.mts
 *
 * Takes the key from STRIPE_API_KEY, or `--api-key <key>`.
 */

import { stripeAgreementHandler } from "../src/core/providers/stripe/agreement-handler";
import { stripeCatalogHandler } from "../src/core/providers/stripe/catalog-handler";
import type { HandlerContext } from "../src/core/types/registry";
import type { RawRecord, TargetObject } from "../src/core/types/common";
import type { SyncHandler } from "../src/core/types/registry";

function apiKey(): string {
  const flag = process.argv.indexOf("--api-key");
  const key = flag === -1 ? process.env["STRIPE_API_KEY"] : process.argv[flag + 1];
  if (key === undefined || key === "") {
    throw new Error("No key: set STRIPE_API_KEY or pass --api-key <key>");
  }
  if (!key.includes("_test_")) {
    // A live key would make this script read a real merchant's subscriptions.
    throw new Error(`Refusing to run against a non-test key (${key.slice(0, 8)}…)`);
  }
  return key;
}

const ctx: HandlerContext = {
  integrationId: "verify",
  accessToken: apiKey(),
  metadata: {},
  // Stripe never narrows a request by these, but the catalog handler reads
  // them to decide whether the per-product features fan-out is worth running.
  // Declared here so this script exercises what a mapped integration does; an
  // empty map would make the features section silently report zero.
  requestedSourcePaths: new Map([["productFeature", ["feature_name"]]]),
};

/** Every record a handler yields, bucketed by target object. */
async function collect(
  handler: SyncHandler
): Promise<Map<TargetObject, RawRecord[]>> {
  const byObject = new Map<TargetObject, RawRecord[]>();
  for await (const page of handler.fetchPages(ctx)) {
    const bucket = byObject.get(page.object) ?? [];
    bucket.push(...page.records);
    byObject.set(page.object, bucket);
  }
  return byObject;
}

const str = (value: unknown): string =>
  value === undefined || value === null ? "—" : String(value);

const day = (value: unknown): string =>
  typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "—";

// --- Catalog ---------------------------------------------------------------

const catalog = await collect(stripeCatalogHandler);
const products = catalog.get("product") ?? [];
const offerings = catalog.get("offering") ?? [];

console.log(`\n=== catalog: ${products.length} products, ${offerings.length} offerings ===\n`);
console.log(
  "offering_name".padEnd(24),
  "amount".padEnd(9),
  "cur".padEnd(4),
  "interval".padEnd(9),
  "n",
  "active",
  "product"
);
for (const offering of offerings) {
  console.log(
    str(offering["offering_name"]).slice(0, 23).padEnd(24),
    str(offering["unit_amount"]).padEnd(9),
    str(offering["currency"]).padEnd(4),
    str(offering["interval"]).padEnd(9),
    str(offering["interval_count"]).padEnd(1),
    str(offering["active"]).padEnd(6),
    str(offering["product_id"])
  );
}

const productFeatures = catalog.get("productFeature") ?? [];

console.log(`\n=== features: ${productFeatures.length} attachments ===\n`);
console.log("feature_name".padEnd(22), "lookup_key".padEnd(18), "feature_id".padEnd(22), "product");
for (const feature of productFeatures) {
  console.log(
    str(feature["feature_name"]).slice(0, 21).padEnd(22),
    str(feature["lookup_key"]).slice(0, 17).padEnd(18),
    str(feature["feature_id"]).slice(0, 21).padEnd(22),
    str(feature["product_id"])
  );
}

// --- Agreements ------------------------------------------------------------

const agreementRecords = await collect(stripeAgreementHandler);
const agreements = agreementRecords.get("agreement") ?? [];
const subscriptions = agreementRecords.get("subscription") ?? [];

console.log(
  `\n=== agreement: ${agreements.length} agreements, ${subscriptions.length} subscriptions ===\n`
);
console.log(
  "agreement_name".padEnd(26),
  "status".padEnd(9),
  "raw".padEnd(11),
  "n",
  "qty".padEnd(4),
  "renews".padEnd(11),
  "trial".padEnd(11),
  "customer"
);
for (const agreement of agreements) {
  console.log(
    str(agreement["agreement_name"]).slice(0, 25).padEnd(26),
    str(agreement["status"]).padEnd(9),
    str(agreement["raw_status"]).padEnd(11),
    str(agreement["item_count"]).padEnd(1),
    str(agreement["quantity"]).padEnd(4),
    day(agreement["current_period_end"]).padEnd(11),
    day(agreement["trial_ends_at"]).padEnd(11),
    str(agreement["customer_id"])
  );
}

// --- The branches these fixtures exist to cover ----------------------------

const names = agreements.map((a) => String(a["agreement_name"]));
const statuses = new Set(agreements.map((a) => str(a["status"])));

const checks: Array<[string, boolean, string]> = [
  [
    "every agreement has a non-blank name",
    names.length > 0 && names.every((n) => n.trim() !== ""),
    "the required column; blank means every row rejected on every sync",
  ],
  [
    "a name came from a price nickname",
    names.includes("Platform - Monthly"),
    "layer 1 of agreementDisplayName",
  ],
  [
    "a name was synthesized from the money",
    names.some((n) => /^\$|£|¥/.test(n) && n.includes("/")),
    "layer 2 — priceLabel over the embedded price",
  ],
  [
    "a tiered price got the Custom pricing layer",
    names.includes("Custom pricing/month"),
    "layer 3 — no unit_amount to format, and it must match what /catalog shows",
  ],
  [
    "no name fell through to a raw subscription id",
    !names.some((n) => n.startsWith("sub_")),
    "the last resort needs an itemless subscription, which Stripe cannot " +
      "produce — so it is unit-tested against a synthetic shape, and seeing " +
      "it here would mean a price stopped being readable",
  ],
  [
    "a zero-decimal currency formatted without cents",
    names.some((n) => n.startsWith("¥") && !n.includes(".")),
    "JPY: 5000 minor units is ¥5,000, not ¥50.00",
  ],
  [
    "a plural interval_count rendered",
    names.some((n) => /\/\d+ \w+s/.test(n)),
    "$300/3 months",
  ],
  [
    "an annual interval rendered",
    names.some((n) => n.endsWith("/year")),
    "",
  ],
  [
    "a canceled subscription came back",
    statuses.has("canceled"),
    "only reachable with status=all — the churn check",
  ],
  ["a trialing subscription came back", statuses.has("trialing"), ""],
  [
    "an incomplete subscription mapped to draft",
    agreements.some(
      (a) => a["raw_status"] === "incomplete" && a["status"] === "draft"
    ),
    "the status map's collapse, observed rather than asserted in a unit test",
  ],
  [
    "a subscription is cancelling at period end",
    subscriptions.some((s) => s["cancel_at_period_end"] === true),
    "active and cancelling — same column, opposite facts",
  ],
  [
    "a multi-item subscription exists",
    agreements.some((a) => Number(a["item_count"]) > 1),
    "must produce a warning, not a tidy single-offering row",
  ],
  [
    "a quantity above one exists",
    agreements.some((a) => Number(a["quantity"]) > 1),
    "",
  ],
  [
    "every agreement resolved a period end",
    agreements.length > 0 &&
      agreements.every((a) => typeof a["current_period_end"] === "string"),
    "reads off the item today; null here means periodBoundary regressed",
  ],
  [
    "both collection methods appear",
    new Set(subscriptions.map((s) => str(s["collection_method"]))).size > 1,
    "",
  ],
  [
    "an offering is inactive",
    offerings.some((o) => o["active"] === false),
    "the catalog page's inactive badge",
  ],
  [
    "features came back at all",
    productFeatures.length > 0,
    "the probe short-circuited on a seeded account, or the fan-out stopped " +
      "running — the two failures that look identical from the output alone",
  ],
  [
    "every feature resolved a product",
    productFeatures.length > 0 &&
      productFeatures.every((f) => String(f["product_id"] ?? "").startsWith("prod_")),
    "the id comes from the request URL, not the payload; a blank one means " +
      "the handler lost track of which product it was fetching",
  ],
  [
    "one feature is attached to two products",
    (() => {
      const byFeature = new Map<string, Set<string>>();
      for (const f of productFeatures) {
        const id = str(f["feature_id"]);
        const products = byFeature.get(id) ?? new Set<string>();
        products.add(str(f["product_id"]));
        byFeature.set(id, products);
      }
      return [...byFeature.values()].some((products) => products.size > 1);
    })(),
    "api-access on both Platform and Integrations — two rows sharing one " +
      "feature id, the case a Feature table would have made a join row",
  ],
  [
    "a product with no features produced no rows",
    !productFeatures.some((f) => str(f["product_id"]).includes("seats")),
    "Additional Seats is seeded with none; a row here means the parent id is " +
      "being taken from the wrong place",
  ],
  [
    "the unattached feature appears nowhere",
    !productFeatures.some((f) => str(f["lookup_key"]) === "beta-sandbox"),
    "a standalone Feature table is out of scope by design, and this is what " +
      "makes that observable rather than merely claimed",
  ],
  [
    "a lookup key differs from a slug of the name",
    productFeatures.some(
      (f) =>
        str(f["lookup_key"]) === "reporting-v2" &&
        str(f["feature_name"]) === "Advanced reporting"
    ),
    "the column exists because the two are independent; deriving one from " +
      "the other would pass every test where they happen to agree",
  ],
];

console.log("\n=== branches ===\n");
let failed = 0;
for (const [label, ok, why] of checks) {
  if (!ok) failed += 1;
  const note = why === "" ? "" : `  — ${why}`;
  console.log(`${ok ? "ok  " : "MISS"}  ${label}${ok ? "" : note}`);
}

console.log(
  `\n${checks.length - failed}/${checks.length} covered by the seeded sandbox.`
);
if (failed > 0) {
  console.log("A MISS means a fixture stopped driving the branch it was added for.");
  process.exitCode = 1;
}
