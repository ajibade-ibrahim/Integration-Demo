import Link from "next/link";
import { bootstrap } from "@/core/bootstrap";
import { currentUserId } from "@/lib/current-user";
import {
  formatOfferingPrice,
  loadCatalog,
} from "@/core/repositories/catalog-repository";

export const dynamic = "force-dynamic";

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  bootstrap();

  const { tab } = await searchParams;
  const showOfferings = tab === "offerings";

  const { products, offerings, totals } = await loadCatalog(
    await currentUserId()
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <p className="mt-1 text-slate-600">
          Products and their offerings, as your integrations synced them.
        </p>
      </div>

      {totals.products === 0 && totals.offerings === 0 ? (
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
            <Tab href="/catalog" active={!showOfferings}>
              Products ({totals.products})
            </Tab>
            <Tab href="/catalog?tab=offerings" active={showOfferings}>
              Offerings ({totals.offerings})
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

          {showOfferings ? (
            <Table headers={["Offering", "Price", "Product", "Active", "Source"]}>
              {offerings.map((row) => {
                const price = formatOfferingPrice(row);
                return (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Td className="font-medium">{row.name}</Td>
                    <Td>{price ?? <Empty />}</Td>
                    <Td>
                      {row.productName !== null ? (
                        row.productName
                      ) : row.externalProductId !== null ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          unresolved #{row.externalProductId}
                        </span>
                      ) : (
                        <Empty />
                      )}
                    </Td>
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
          ) : (
            <Table
              headers={["Product", "Description", "Offerings", "Active", "Source"]}
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

function Table({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 py-2 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-2 align-top ${className}`}>{children}</td>;
}

function Empty() {
  return <span className="text-slate-300">—</span>;
}
