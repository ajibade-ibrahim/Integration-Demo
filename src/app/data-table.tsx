/**
 * The three table pieces every synced-data page needs.
 *
 * Extracted when `/agreements` became the third page to want them. Two copies
 * were a coincidence; three would have been a convention, and the copies had
 * already begun to differ in whitespace while claiming to be the same table.
 *
 * `Tab` is deliberately **not** here. `/customers` renders its tabs as
 * underlined headings and `/catalog` renders them as pills, and a shared
 * component would have to take a variant flag to keep both — which is more
 * machinery than two small functions are worth. This module holds the pieces
 * that are genuinely identical.
 *
 * A server component with no interactivity, so no `"use client"`.
 */

import type { ReactNode } from "react";

export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
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

export function Td({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-2 align-top ${className}`}>{children}</td>;
}

/**
 * A column with nothing in it.
 *
 * Its own component because "the provider did not tell us" is a state these
 * pages render constantly and must render *consistently* — a dash in one table
 * and an empty cell in another reads as two different facts when it is one.
 */
export function Empty() {
  return <span className="text-slate-300">—</span>;
}
