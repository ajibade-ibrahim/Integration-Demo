import Link from "next/link";
import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  formatOfferingPrice,
  loadCatalog,
  type FeatureOffering,
} from "@/core/repositories/catalog-repository";
import { Empty, Table, Td } from "../data-table";

export const dynamic = "force-dynamic";

/**
 * Which tab is showing.
 *
 * A union resolved once rather than a pair of booleans. Two booleans for three
 * tabs has a fourth state that cannot happen and that a reader has to prove
 * cannot happen; the next tab would make that eight.
 */
type View = "products" | "offerings" | "features";

function viewFrom(tab: string | undefined): View {
  return tab === "offerings" || tab === "features" ? tab : "products";
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  bootstrap();

  const { tab } = await searchParams;
  const view = viewFrom(tab);

  const { products, offerings, features, totals } = await loadCatalog(
    await currentUserId()
  );

  const empty =
    totals.products === 0 && totals.offerings === 0 && totals.features === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <p className="mt-1 text-slate-600">
          Products, their offerings, and the features they include — as your
          integrations synced them.
        </p>
      </div>

      {empty ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-slate-600">Nothing synced yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Connect an integration that serves the Catalog function, then run a
            sync.
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
          <div className="flex gap-2">
            <Tab href="/catalog" active={view === "products"}>
              Products ({totals.products})
            </Tab>
            <Tab href="/catalog?tab=offerings" active={view === "offerings"}>
              Offerings ({totals.offerings})
            </Tab>
            {/*
              Shown even at zero, unlike a tab that hid itself when empty. Most
              Stripe accounts define no entitlements, and "Features (0)" is the
              answer to "did the feature sync work?" — a missing tab would leave
              that indistinguishable from a build without the feature in it.
            */}
            <Tab href="/catalog?tab=features" active={view === "features"}>
              Features ({totals.features})
            </Tab>
          </div>

          {/*
            The consequence of keeping an offering whose product did not
            resolve, stated where someone can act on it. Without this the rows
            are all present and one column is silently empty forever — which is
            data loss that looks like success.
          */}
          {totals.unlinkedOfferings > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {totals.unlinkedOfferings} offering
              {totals.unlinkedOfferings === 1 ? "" : "s"} named a product that is
              not in the catalog. They are kept with the provider&apos;s product
              id, and will link themselves once that product syncs.
            </p>
          )}

          {/*
            Worded more strongly than the offering warning above, because it
            means something worse. An entitlement's two parents — an offering
            and a feature — are both written earlier in the same run, so an
            unresolved half means that parent was rejected, and no later sync
            fixes that on its own.
          */}
          {totals.unlinkedEntitlements > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {totals.unlinkedEntitlements} entitlement
              {totals.unlinkedEntitlements === 1 ? "" : "s"} could not be linked
              to an offering or a feature, although the sync wrote both first.
              Check the latest run report for a rejected offering or feature.
            </p>
          )}

          {view === "offerings" ? (
            <Table
              headers={["Offering", "Price", "Product", "Entitlements", "Active", "Source"]}
            >
              {offerings.map((row) => {
                const price = formatOfferingPrice(row);
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{price ?? <Empty />}</Td>
                    <Td>
                      <ParentCell
                        name={row.productName}
                        externalId={row.externalProductId}
                      />
                    </Td>
                    <Td>{row.entitlementCount}</Td>
                    <Td>
                      <ActiveCell value={row.active} />
                    </Td>
                    <Td className="text-xs text-slate-400">
                      {row.integrationLabel}
                      <span className="ml-1 font-mono">
                        #{row.externalSourceId}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          ) : view === "features" ? (
            totals.features === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
                No features synced. Stripe and Chargebee return these only for
                accounts using their Entitlements APIs — if yours does not,
                there is nothing here to miss, and the sync stops after one
                request rather than asking once per product or feature.
              </p>
            ) : (
              <Table
                headers={["Feature", "Lookup key", "Metered", "Offerings", "Source"]}
              >
                {features.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>
                      {/*
                        Monospaced because it is an identifier that code reads,
                        not a label a person reads — which is the whole reason
                        it is stored in its own column beside the name.
                      */}
                      {row.lookupKey !== null ? (
                        <span className="font-mono text-xs">{row.lookupKey}</span>
                      ) : (
                        <Empty />
                      )}
                    </Td>
                    <Td>
                      <MeteredCell metered={row.isMetered} unit={row.unit} />
                    </Td>
                    <Td>
                      <OfferingsCell offerings={row.offerings} />
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
            )
          ) : (
            <Table
              headers={[
                "Product",
                "Description",
                "Offerings",
                "Active",
                "Source",
              ]}
            >
              {products.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Td className="font-medium">{row.name}</Td>
                  <Td className="text-slate-600">
                    {row.description ?? <Empty />}
                  </Td>
                  <Td>{row.offeringCount}</Td>
                  <Td>
                    <ActiveCell value={row.active} />
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
          )}
        </>
      )}
    </div>
  );
}

/**
 * The parent a child row belongs to — resolved, unresolved, or never named.
 *
 * Three states and one renderer, used by offerings (whose parent is a product).
 * Features show a *list* of parents instead — see `OfferingsCell` — but the
 * badge is the same one, because an "unresolved" that looked different on the
 * two tabs would read as two different problems.
 */
function ParentCell({
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
 * Every offering a feature belongs to, comma-separated.
 *
 * A feature is one row here however many offerings include it, so the
 * single-parent renderer above does not fit: a resolved offering and an
 * unresolved one have to appear side by side in the same cell.
 */
function OfferingsCell({ offerings }: { offerings: FeatureOffering[] }) {
  if (offerings.length === 0) return <Empty />;
  return (
    <>
      {offerings.map((offering, index) => (
        <span key={`${offering.name ?? ""}#${offering.externalId ?? ""}`}>
          {index > 0 ? ", " : null}
          {offering.name !== null ? (
            offering.name
          ) : (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
              unresolved #{offering.externalId}
            </span>
          )}
        </span>
      ))}
    </>
  );
}

/**
 * A feature's metered flag and its unit.
 *
 * Three states for metered, not two: null means the provider never told us,
 * which is a different fact from "not metered" — the column is nullable so the
 * two can be told apart. The unit is shown beside it because "metered" alone
 * says only that something is counted; the unit says what.
 */
function MeteredCell({
  metered,
  unit,
}: {
  metered: boolean | null;
  unit: string | null;
}) {
  if (metered === null && unit === null) return <Empty />;
  return (
    <span className="text-xs">
      {metered === null ? null : metered ? (
        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800">
          metered
        </span>
      ) : (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
          flag
        </span>
      )}
      {unit !== null && <span className="ml-1 text-slate-500">{unit}</span>}
    </span>
  );
}

/**
 * Three states, not two.
 *
 * `null` means the provider never told us, which is a different fact from
 * "inactive" — and the column is nullable precisely so the two can be told
 * apart. Rendering a null as "No" would invent an answer.
 */
function ActiveCell({ value }: { value: boolean | null }) {
  if (value === null) return <Empty />;
  return value ? (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">
      active
    </span>
  ) : (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
      archived
    </span>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
        active
          ? "bg-slate-900 text-white"
          : "bg-white text-slate-700 hover:bg-slate-100"
      }`}
    >
      {children}
    </Link>
  );
}
