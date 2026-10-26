/**
 * Stigg catalog sync handler — products, the plans and addons that sell them,
 * their charges, and the features and entitlements that describe what is
 * included.
 *
 * Stigg's resources map onto ours as follows:
 *
 *   Product          → `product`
 *   Plan and Addon   → `offering` (both are packages under one product)
 *   Charge           → `price` (base, usage, minimum-spend or credit)
 *   Feature          → `feature`
 *   FEATURE entitlement (on a plan or addon) → `entitlement`
 *
 * Three details are handled here rather than by a mapping rule:
 *
 * 1. **Only published packages, one version each.** Editing a package creates
 *    a new version under the same id, so the plans/addons lists are buffered
 *    and run through `bestCatalogVersion` before an offering page is yielded; a
 *    newer *draft* must not hide the published version the customer can
 *    actually buy. `publishedOnly` runs first, so `DRAFT` and `ARCHIVED`
 *    packages are not synced at all — the catalog is what is for sale.
 *
 * 2. **The charge fan-out is per package.** Stigg has no flat charges list: a
 *    package's prices come from `/plans/{id}/charges` or `/addons/{id}/charges`,
 *    and its entitlements from a sibling endpoint. Both run only when the user
 *    mapped the object they feed, so an account that maps only products makes
 *    none of those calls.
 *
 * 3. **The entitlement endpoints expose no cursor.** Unlike every other Stigg
 *    list, they document no `limit`/`after`, so each package costs exactly one
 *    request and its `data` is read whole. If a live response ever carries a
 *    non-null `pagination.next` there, the documented contract has changed and
 *    this helper needs the standard cursor loop.
 *
 * Ordering is the `object-schema.ts` write order — product, offering, price,
 * feature, entitlement — so every association resolves against the index the
 * earlier pages built. `ctx.requestedSourcePaths` never narrows a request
 * (Stigg has no field-selection parameter); it only decides which fan-outs are
 * worth running.
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession, type ProviderSession } from "../http";
import {
  activeFromStatus,
  addonChargesUrl,
  addonEntitlementsUrl,
  addonsUrl,
  bestCatalogVersion,
  featuresUrl,
  flattenCharge,
  flattenEntitlement,
  flattenFeature,
  parseStiggPage,
  planChargesUrl,
  planEntitlementsUrl,
  plansUrl,
  productsUrl,
  publishedOnly,
  STIGG_MAX_PAGES,
  stiggPageSize,
  type StiggPackage,
} from "./api";
import { STIGG_SESSION_OPTIONS } from "./identity-handler";

/**
 * Page one Stigg list endpoint to the end, applying `decorate` to every record.
 *
 * The identity handler's three stop conditions, shared here rather than
 * written per resource: an absent cursor is the provider's own end-of-data
 * signal, a cursor that did not advance is the same situation the opaque-token
 * guard exists for, and the page cap is the runaway bound.
 */
async function* pageResource(
  session: ProviderSession,
  object: TargetObject,
  urlFor: (limit: number, after?: string) => string,
  decorate: (record: RawRecord) => RawRecord,
): AsyncGenerator<SourcePage> {
  const perPage = stiggPageSize();

  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const body = parseStiggPage(await session.getJson(urlFor(perPage, cursor)));

    yield {
      object,
      records: body.records.map((record: RawRecord) => ({
        // Spread first, so ours win if Stigg ever ships fields of these names.
        ...record,
        ...decorate(record),
      })),
    };

    pagesFetched += 1;
    if (pagesFetched >= STIGG_MAX_PAGES) break;

    if (body.nextCursor === undefined || body.nextCursor === cursor) break;
    cursor = body.nextCursor;
  }
}

/**
 * One package's entitlements, read whole from a single response.
 *
 * No cursor parameter exists on these endpoints, so this is `parseStiggPage`
 * once rather than a loop. CREDIT entitlements are dropped: a credit is a
 * custom-currency pool, not a capability grant, and the canonical
 * `Feature`/`Entitlement` tables have no home for one.
 */
async function fetchEntitlements(
  session: ProviderSession,
  url: string,
  packageId: string,
): Promise<RawRecord[]> {
  const body = parseStiggPage(await session.getJson(url));

  const records: RawRecord[] = [];
  for (const entitlement of body.records) {
    if (asString(entitlement["type"]) === "CREDIT") continue;
    const flat = flattenEntitlement(entitlement, packageId);
    if (flat !== undefined) records.push(flat);
  }
  return records;
}

/** The sellable packages a charge or entitlement fan-out iterates. */
function packagesFrom(records: readonly RawRecord[], kind: "plan" | "addon"): StiggPackage[] {
  const packages: StiggPackage[] = [];
  for (const record of records) {
    const id = asString(record["id"]);
    if (id === undefined) continue;
    const active = record["active"];
    packages.push({
      id,
      name: asString(record["displayName"])?.trim() ?? id,
      kind,
      ...(typeof active === "boolean" ? { active } : {}),
    });
  }
  return packages;
}

export const stiggCatalogHandler: SyncHandler = {
  objects: ["product", "offering", "price", "feature", "entitlement"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(ctx, "Stigg", STIGG_SESSION_OPTIONS);
    const perPage = stiggPageSize();

    // 1. Products.
    yield* pageResource(session, "product", productsUrl, activeFromStatus);

    // 2. Plans and addons — published only — buffered so versions collapse to
    //    one offering each.
    const planRecords: RawRecord[] = [];
    for await (const page of pageResource(
      session,
      "offering",
      plansUrl,
      activeFromStatus,
    )) {
      planRecords.push(...page.records);
    }

    const addonRecords: RawRecord[] = [];
    for await (const page of pageResource(
      session,
      "offering",
      addonsUrl,
      activeFromStatus,
    )) {
      addonRecords.push(...page.records);
    }

    const plans = bestCatalogVersion(publishedOnly(planRecords));
    const addons = bestCatalogVersion(publishedOnly(addonRecords));
    const offerings = [...plans, ...addons];

    for (let i = 0; i < offerings.length; i += perPage) {
      yield { object: "offering", records: offerings.slice(i, i + perPage) };
    }

    const packages: StiggPackage[] = [
      ...packagesFrom(plans, "plan"),
      ...packagesFrom(addons, "addon"),
    ];

    // 3. Charges, one paginated request chain per package.
    const priceMapped =
      (ctx.requestedSourcePaths.get("price") ?? []).length > 0;
    if (priceMapped) {
      for (const pkg of packages) {
        const chargesUrl =
          pkg.kind === "plan" ? planChargesUrl : addonChargesUrl;
        yield* pageResource(session, "price", (limit, after) =>
          chargesUrl(pkg.id, limit, after),
          (charge) => flattenCharge(charge, pkg),
        );
      }
    }

    // 4. Feature definitions. Independent of the entitlement pass: different
    //    endpoint, so mapping only `entitlement` must still not fetch these.
    const featureMapped =
      (ctx.requestedSourcePaths.get("feature") ?? []).length > 0;
    if (featureMapped) {
      yield* pageResource(session, "feature", featuresUrl, flattenFeature);
    }

    // 5. Entitlements, one single-response request per package.
    const entitlementMapped =
      (ctx.requestedSourcePaths.get("entitlement") ?? []).length > 0;
    if (entitlementMapped) {
      for (const pkg of packages) {
        const url =
          pkg.kind === "plan"
            ? planEntitlementsUrl(pkg.id)
            : addonEntitlementsUrl(pkg.id);
        const records = await fetchEntitlements(session, url, pkg.id);
        for (let i = 0; i < records.length; i += perPage) {
          yield {
            object: "entitlement",
            records: records.slice(i, i + perPage),
          };
        }
      }
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // One handler serves every object: an entitlement carries the synthesized
    // `entitlement_id` because its raw `id` (the feature id) repeats across
    // packages. Checking it first leaves the `id` fallback unambiguous.
    return asString(record["entitlement_id"]) ?? asString(record["id"]);
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      case "offering":
        return { product: asString(record["productId"]) };
      case "price":
        return { offering: asString(record["offering_id"]) };
      // A definition is a root record: it hangs off nothing.
      case "feature":
        return {};
      // The link names both of its parents, and neither is primary.
      case "entitlement":
        return {
          offering: asString(record["offering_id"]),
          feature: asString(record["feature_id"]),
        };
      default:
        return {};
    }
  },
};
