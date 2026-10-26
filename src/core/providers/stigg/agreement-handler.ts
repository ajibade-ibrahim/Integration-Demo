/**
 * Stigg's `agreement` function: subscriptions as agreements, their inline
 * lines, and their attached coupons.
 *
 * Three Stigg-shaped facts, each the reason for a decision in `api.ts`:
 *
 *   1. **One endpoint.** `GET /api/v1/subscriptions` carries the plan, the
 *      addons, the price overrides, the coupons and the dates inline, so the
 *      whole function is a single paginated list — no per-subscription fan-out.
 *      The all-statuses filter is applied on every request so canceled and
 *      expired subscriptions are seen; see `STIGG_SUBSCRIPTION_STATUSES`.
 *   2. **No effective entitlements.** `agreementEntitlement` is deliberately not
 *      written. The list payload excludes entitlements by design, the single
 *      subscription only carries bare override ids with no values, and
 *      `/customers/{id}/entitlements` is the *customer* aggregate that folds
 *      every subscription and the customer-level promotional grants together —
 *      the grants `AgreementEntitlement` already declares out of scope. Mapping
 *      that aggregate per agreement would double-count and misattribute, so the
 *      object stays unbuilt rather than half-built. The catalog function owns
 *      plan-level entitlements, which is where Stigg actually states them.
 *   3. **Lines are the plan plus addons.** See `flattenAgreementItems`: a
 *      metered-feature price override is an adjustment, not a provisioned line,
 *      and is kept on the subscription record for custom fields instead.
 *
 * Docs: https://docs.stigg.io/api-reference/subscriptions/get-a-list-of-subscriptions
 */

import type { RawRecord, TargetObject } from "../../types/common";
import type {
  ExternalRefs,
  HandlerContext,
  SourcePage,
  SyncHandler,
} from "../../types/registry";
import { asString, createProviderSession } from "../http";
import {
  flattenAgreementDiscount,
  flattenAgreementItems,
  flattenSubscription,
  hasAddonsKey,
  hasCouponsKey,
  parseStiggPage,
  STIGG_MAX_PAGES,
  stiggPageSize,
  subscriptionCoupons,
  subscriptionCurrency,
  subscriptionsUrl,
} from "./api";
import { STIGG_SESSION_OPTIONS } from "./identity-handler";

export const stiggAgreementHandler: SyncHandler = {
  objects: ["agreement", "subscription", "agreementItem", "agreementDiscount"],
  async *fetchPages(ctx: HandlerContext): AsyncIterable<SourcePage> {
    const session = createProviderSession(
      ctx,
      "Stigg",
      STIGG_SESSION_OPTIONS,
    );

    const perPage = stiggPageSize();

    // Coupons are inline, so this gate saves rows rather than requests — the
    // opposite of Chargebee's per-subscription entitlement fan-out. Kept anyway
    // for the same reason: a site that maps no discount rule should not have
    // empty discount rows written for it, and the gate is what keeps the
    // agreementDiscount object entirely absent from a run that does not want it.
    const discountsMapped =
      (ctx.requestedSourcePaths.get("agreementDiscount") ?? []).length > 0;

    let cursor: string | undefined;
    let pagesFetched = 0;

    for (;;) {
      const body = parseStiggPage(
        await session.getJson(subscriptionsUrl(perPage, cursor)),
      );

      const agreements: RawRecord[] = [];
      const subscriptions: RawRecord[] = [];
      const items: RawRecord[] = [];
      const discounts: RawRecord[] = [];
      let pageItemsComplete = true;
      let pageDiscountsComplete = true;

      for (const subscription of body.records) {
        const subscriptionId = asString(subscription["id"]);
        // No id means no upsert key and no way to name the parent, so the
        // record is skipped. The writer's rejection path would say the same
        // thing less specifically.
        if (subscriptionId === undefined) continue;

        // Spread first, so the synthesized fields win where the names collide.
        const flattened: RawRecord = {
          ...subscription,
          ...flattenSubscription(subscription),
        };

        agreements.push(flattened);
        subscriptions.push(flattened);

        items.push(...flattenAgreementItems(subscription, subscriptionId));

        // The key-presence gate, not the array length: an absent `addons` would
        // otherwise look exactly like "this subscription has no addons", and
        // the reconciling writer would delete every stored line.
        if (!hasAddonsKey(subscription)) pageItemsComplete = false;

        if (discountsMapped) {
          if (!hasCouponsKey(subscription)) pageDiscountsComplete = false;
          const currency = subscriptionCurrency(subscription);
          for (const coupon of subscriptionCoupons(subscription)) {
            const flat = flattenAgreementDiscount(
              coupon,
              subscriptionId,
              currency,
            );
            if (flat !== undefined) discounts.push(flat);
          }
        }
      }

      yield { object: "agreement", records: agreements };
      yield { object: "subscription", records: subscriptions };
      // `complete` is per page and the engine ANDs pages, so a later page that
      // carried the key cannot rescue an earlier one that did not.
      yield {
        object: "agreementItem",
        records: items,
        complete: pageItemsComplete,
      };
      if (discountsMapped) {
        yield {
          object: "agreementDiscount",
          records: discounts,
          complete: pageDiscountsComplete,
        };
      }

      pagesFetched += 1;
      if (pagesFetched >= STIGG_MAX_PAGES) break;

      // An absent cursor is Stigg's own end-of-data signal; a cursor that did
      // not advance is the same situation by a different route. The
      // echoed-token guard the other cursored Stigg handlers keep.
      if (body.nextCursor === undefined || body.nextCursor === cursor) break;
      cursor = body.nextCursor;
    }
  },

  externalIdOf(record: RawRecord): string | undefined {
    // A line carries `item_id` and a discount `discount_id`, both synthesized;
    // agreement and subscription carry Stigg's own `id`. The synthetic keys are
    // checked first and both take precedence over a raw `id`, which a discount
    // record does carry — the *coupon's* id, account-wide and shared across
    // subscriptions, so it must never be the upsert key.
    return (
      asString(record["item_id"]) ??
      asString(record["discount_id"]) ??
      asString(record["id"])
    );
  },

  externalRefsOf(record: RawRecord, object: TargetObject): ExternalRefs {
    switch (object) {
      // The customer is Stigg's `customerId`; the offering is the plan, which
      // resolves because the catalog handler maps plans to offerings.
      case "agreement":
        return {
          customer: asString(record["customer_id"]),
          offering: asString(record["offering_id"]),
        };

      // Same source record, same provider id, its own table.
      case "subscription":
        return { agreement: asString(record["id"]) };

      // The agreement is the injected `agreement_id`, not a payload field; the
      // offering is the plan on the plan line and the addon on an addon line,
      // both of which catalog maps to offerings. No price ref: Stigg names no
      // charge id on a subscription.
      case "agreementItem":
        return {
          agreement: asString(record["agreement_id"]),
          offering: asString(record["offering_id"]),
        };

      // One parent only; a coupon has no table of ours to point at.
      case "agreementDiscount":
        return { agreement: asString(record["agreement_id"]) };

      default:
        return {};
    }
  },
};
