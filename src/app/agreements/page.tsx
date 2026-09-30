import Link from "next/link";

import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  loadAgreements,
  type AgreementDiscountRow,
  type AgreementEntitlementRow,
  type AgreementItemRow,
} from "@/core/repositories/agreement-repository";
import { Empty, Table, Td } from "../data-table";

export const dynamic = "force-dynamic";

export default async function AgreementsPage() {
  bootstrap();

  const { agreements, totals } = await loadAgreements(await currentUserId());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agreements</h1>
        <p className="mt-1 text-slate-600">
          What your customers agreed to — subscriptions today, order forms and
          contracts when a provider supplies them.
        </p>
      </div>

      {totals.agreements === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-slate-600">Nothing synced yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Connect an integration that serves the Agreement function, then run
            a sync.
          </p>
          <Link
            href="/integrations"
            className="mt-3 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Go to integrations
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <Stat label="Agreements" value={totals.agreements} />
            <Stat label="In force" value={totals.active} />
          </div>

          {/*
            Two unresolved counts, not one. An agreement's customer comes from
            the identity function and its offering from catalog, so a row can
            have either half linked and the other not — and reporting a single
            "unresolved" figure would be wrong about half of every such row.
          */}
          {totals.unlinkedCustomers > 0 && (
            <Notice>
              {totals.unlinkedCustomers} agreement
              {totals.unlinkedCustomers === 1 ? "" : "s"} named a customer that
              is not synced. Add the <strong>Identity</strong> function to that
              integration and they will link themselves on the next sync.
            </Notice>
          )}

          {totals.unlinkedOfferings > 0 && (
            <Notice>
              {totals.unlinkedOfferings} agreement
              {totals.unlinkedOfferings === 1 ? "" : "s"} named an offering that
              is not in the catalog. Add the <strong>Catalog</strong> function to
              that integration and they will link themselves on the next sync.
            </Notice>
          )}

          {/*
            The multi-item caveat, narrowed to what is still true. Every line
            is stored now and listed under the agreement's name — what has not
            changed is that the Price column reads the *one* offering the
            agreement links, so a plan plus 25 seats still shows the plan's
            price. Saying nothing would make that look like the whole amount.
          */}
          {totals.multiItem > 0 && (
            <Notice>
              {totals.multiItem} subscription
              {totals.multiItem === 1 ? " carries" : "s carry"} more than one
              priced line. Expand the agreement&apos;s name to see them all —
              the Price column shows only the line the agreement links, not the
              total.
            </Notice>
          )}

          <Table
            headers={[
              "Agreement",
              "Type",
              "Status",
              "Customer",
              "Price",
              "Renews",
              "Source",
            ]}
          >
            {agreements.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Td className="font-medium">
                  {row.name}
                  <DetailsCell
                    items={row.items}
                    itemCount={row.itemCount}
                    entitlements={row.entitlements}
                    discounts={row.discounts}
                  />
                </Td>
                <Td className="text-slate-600">
                  {row.agreementType.replace("_", " ")}
                </Td>
                <Td>
                  <StatusCell
                    status={row.status}
                    cancelAtPeriodEnd={row.cancelAtPeriodEnd}
                    cancelAt={row.cancelAt}
                    trialEndsAt={row.trialEndsAt}
                  />
                </Td>
                <Td>
                  <LinkCell
                    name={row.customerName}
                    externalId={row.externalCustomerId}
                  />
                </Td>
                <Td>
                  {row.price ?? (
                    <LinkCell
                      name={row.offeringName}
                      externalId={row.externalOfferingId}
                    />
                  )}
                  {row.quantity !== null && row.quantity > 1 && (
                    <span className="ml-1 text-xs text-slate-500">
                      × {row.quantity}
                    </span>
                  )}
                </Td>
                <Td className="text-slate-600">
                  {row.currentPeriodEnd === null ? (
                    <Empty />
                  ) : (
                    row.currentPeriodEnd.toISOString().slice(0, 10)
                  )}
                  {row.billingPeriod !== null && (
                    <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-600">
                      {billingPeriodLabel(
                        row.billingPeriod,
                        row.billingPeriodCount
                      )}
                    </span>
                  )}
                </Td>
                <Td className="text-xs text-slate-400">
                  {row.integrationLabel}
                  <span className="ml-1 font-mono">
                    #{row.externalSourceId}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * Everything an agreement carries below its header, disclosed on demand.
 *
 * A `<details>` element rather than a click handler, which keeps this page a
 * server component — the whole route renders without shipping any JavaScript,
 * and one expandable cell is not worth giving that up for.
 *
 * One disclosure for lines, entitlements and discounts rather than three,
 * because they answer one question — "what is under this agreement" — and three
 * triangles on a row with all three would be more chrome than content. Nothing
 * is shown when there is nothing to show and the provider's line count matches,
 * which is the overwhelming majority of rows.
 *
 * The one case worth a word even with nothing to disclose is the provider
 * saying there were more lines than we stored, which means some were rejected;
 * silence there would read as a single-line subscription.
 */
function DetailsCell({
  items,
  itemCount,
  entitlements,
  discounts,
}: {
  items: AgreementItemRow[];
  itemCount: number | null;
  entitlements: AgreementEntitlementRow[];
  discounts: AgreementDiscountRow[];
}) {
  const missingLines = itemCount !== null && itemCount > items.length;
  const hasLines = items.length >= 2;
  const hasEntitlements = entitlements.length > 0;
  const hasDiscounts = discounts.length > 0;

  if (!hasLines && !hasEntitlements && !hasDiscounts) {
    if (missingLines) {
      return (
        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
          {itemCount} lines reported, {items.length} stored
        </span>
      );
    }
    return null;
  }

  const summary = [
    hasLines ? `${items.length} lines` : null,
    hasEntitlements ? `${entitlements.length} entitlements` : null,
    hasDiscounts ? `${discounts.length} discounts` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <details className="mt-1 font-normal">
      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">
        {summary}
      </summary>
      <div className="mt-1 space-y-1">
        {hasLines && <LineList items={items} />}
        {hasEntitlements && <EntitlementList entitlements={entitlements} />}
        {hasDiscounts && <DiscountList discounts={discounts} />}
        {missingLines && (
          <p className="text-xs text-amber-800">
            {itemCount} lines reported, {items.length} stored
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * The agreement's priced lines.
 *
 * No total, deliberately. Summing the lines needs each one's price times its
 * quantity, and a line whose offering did not resolve has no price — so the
 * sum would silently under-report exactly when something is already wrong.
 * The provider's own API is where a trustworthy total comes from.
 */
function LineList({ items }: { items: AgreementItemRow[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.id} className="text-xs text-slate-600">
          <LinkCell
            name={item.offeringName}
            externalId={item.externalOfferingId}
          />
          {item.quantity !== null && item.quantity > 1 && (
            <span className="ml-1 text-slate-500">× {item.quantity}</span>
          )}
          {/*
            Rendered only when the provider actually typed the line. Stripe
            does not, so this is absent on every Stripe row today — and an
            "add-on" badge inferred from position would be the guess the column
            exists to avoid.
          */}
          {item.itemType !== null && (
            <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              {item.itemType.replace("_", " ")}
            </span>
          )}
          {item.billingModel !== null && (
            <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              {item.billingModel.replace("_", " ")}
            </span>
          )}
          {/*
            Stated values only, and only when the provider stated one. Chargebee
            puts a unit price on every line whether or not anything was
            overridden, so this is a fact about the line rather than an
            assertion that it differs from the catalog.
          */}
          {item.unitPriceMinor !== null && (
            <span
              className="ml-1 text-slate-500"
              title="What this line bills per unit for this subscription, in minor units"
            >
              {item.unitPriceMinor}/unit
            </span>
          )}
          {item.freeQuantity !== null && item.freeQuantity > 0 && (
            <span className="ml-1 text-slate-500">
              incl. {item.freeQuantity} free
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The effective entitlements — what this subscriber actually gets.
 *
 * Distinct from the catalog's baseline list and never shown alongside it as a
 * total, because the two overlap by construction: an inherited value appears in
 * both. `isEnabled === false` is called out rather than rendered as a value,
 * because "not included" and "included with a limit of zero" are different
 * facts and only one of them is a limit.
 */
function EntitlementList({
  entitlements,
}: {
  entitlements: AgreementEntitlementRow[];
}) {
  return (
    <ul className="space-y-0.5">
      {entitlements.map((entitlement) => (
        <li key={entitlement.id} className="text-xs text-slate-600">
          <span className="font-medium">
            {entitlement.featureName ??
              entitlement.externalFeatureId ??
              "unlinked feature"}
          </span>
          {entitlement.isEnabled === false ? (
            <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-slate-500">
              not enabled
            </span>
          ) : (
            entitlement.value !== null && (
              <span className="ml-1">
                {entitlement.value}
                {entitlement.valueName !== null && (
                  <span className="text-slate-400"> ({entitlement.valueName})</span>
                )}
              </span>
            )
          )}
          {entitlement.isOverride === true && (
            <span className="ml-1 rounded bg-sky-100 px-1 py-0.5 text-sky-700">
              override
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The stated discounts, as a badge each.
 *
 * The amount is shown as the provider stated it — a percentage or a minor-unit
 * figure — and never resolved against a price, for the reason the lines have no
 * total: the arithmetic would be ours, not the provider's.
 */
function DiscountList({ discounts }: { discounts: AgreementDiscountRow[] }) {
  return (
    <ul className="space-y-0.5">
      {discounts.map((discount) => (
        <li key={discount.id} className="text-xs text-slate-600">
          <span className="rounded bg-emerald-50 px-1 py-0.5 text-emerald-700">
            {discountLabel(discount)}
          </span>
          {discount.label !== null && (
            <span className="ml-1">{discount.label}</span>
          )}
          {discount.endsAt !== null && (
            <span className="ml-1 text-slate-500">
              until {discount.endsAt.toISOString().slice(0, 10)}
            </span>
          )}
          {discount.status !== null && discount.status !== "active" && (
            <span className="ml-1 text-slate-500">{discount.status}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function discountLabel(discount: AgreementDiscountRow): string {
  if (discount.kind === "percentage" && discount.percentOff !== null) {
    return `${discount.percentOff}% off`;
  }
  if (discount.kind === "fixed_amount" && discount.amountOffMinor !== null) {
    return `${discount.amountOffMinor} off`;
  }
  if (discount.kind === "free_items") return "free items";
  return discount.kind ?? "discount";
}

/**
 * A cadence rendered as words: "monthly", "every 3 months".
 *
 * The count is only spelled out when it is more than one, because "every 1
 * month" reads as a machine talking. An unrecognised unit is shown as-is rather
 * than hidden, so a new provider value is visible rather than silently blank.
 */
function billingPeriodLabel(period: string, count: number | null): string {
  const every = count === null || count <= 1;
  if (every) {
    switch (period) {
      case "day":
        return "daily";
      case "week":
        return "weekly";
      case "month":
        return "monthly";
      case "year":
        return "yearly";
      default:
        return period;
    }
  }
  return `every ${count} ${period}s`;
}

/**
 * An association that may not have resolved.
 *
 * Three states, like `ActiveCell` on the catalog page: linked, named but
 * unresolved, or never claimed at all. The middle one is the reason this is not
 * just `{name ?? <Empty />}` — an agreement that names a customer we do not
 * have is a different situation from one that names nobody, and only the first
 * will fix itself.
 */
function LinkCell({
  name,
  externalId,
}: {
  name: string | null;
  externalId: string | null;
}) {
  if (name !== null) return <>{name}</>;
  if (externalId !== null) {
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
        unresolved #{externalId}
      </span>
    );
  }
  return <Empty />;
}

/**
 * Status, plus the two things that change what it means.
 *
 * `active` and `active but cancelling at period end` are the same column value
 * and opposite commercial facts, so the badge says so. A trial end date gets
 * the same treatment: `trialing` without a date is a state, with one it is a
 * deadline.
 */
function StatusCell({
  status,
  cancelAtPeriodEnd,
  cancelAt,
  trialEndsAt,
}: {
  status: string | null;
  cancelAtPeriodEnd: boolean | null;
  cancelAt: Date | null;
  trialEndsAt: Date | null;
}) {
  if (status === null) return <Empty />;

  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "trialing"
        ? "bg-sky-100 text-sky-800"
        : status === "past_due"
          ? "bg-amber-100 text-amber-800"
          : status === "canceled" || status === "expired"
            ? "bg-rose-100 text-rose-800"
            : "bg-slate-100 text-slate-600";

  return (
    <span className="whitespace-nowrap">
      <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`}>
        {status.replace("_", " ")}
      </span>
      {/*
        The exact date beats the flag when the provider states one: "cancelling"
        says a cancellation is scheduled, "cancels on 2026-04-01" says when, and
        a reader deciding whether to act needs the second.
      */}
      {cancelAt !== null ? (
        <span className="ml-1 text-xs text-slate-500">
          cancels on {cancelAt.toISOString().slice(0, 10)}
        </span>
      ) : (
        cancelAtPeriodEnd === true && (
          <span className="ml-1 rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">
            cancelling
          </span>
        )
      )}
      {status === "trialing" && trialEndsAt !== null && (
        <span className="ml-1 text-xs text-slate-500">
          until {trialEndsAt.toISOString().slice(0, 10)}
        </span>
      )}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
      <span className="text-slate-500">{label}</span>{" "}
      <span className="font-medium">{value}</span>
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {children}
    </p>
  );
}
