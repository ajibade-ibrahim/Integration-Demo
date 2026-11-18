/**
 * The URL contract the data pages share.
 *
 * These three helpers decide which rows a page shows and whether its links
 * keep that filter, so they are tested apart from the pages: a regression here
 * is silent — the page still renders, just the wrong slice of it.
 */

import { describe, expect, it } from "vitest";

import { PAGE_SIZE } from "@/core/repositories/data-page";
import {
  buildDataHref,
  pageCount,
  parsePage,
} from "@/lib/integration-scope";

describe("parsePage", () => {
  it("treats anything that is not a positive integer as page 1", () => {
    for (const raw of [undefined, "", "0", "-2", "2.7", "abc", "1e3"]) {
      expect(parsePage(raw)).toBe(1);
    }
  });

  it("reads a real page number", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(" 12 ")).toBe(12);
  });
});

describe("buildDataHref", () => {
  it("omits empty parameters and page 1", () => {
    expect(buildDataHref("/customers", {})).toBe("/customers");
    expect(
      buildDataHref("/customers", {
        tab: "contacts",
        integration: "int_1",
        page: 1,
      })
    ).toBe("/customers?tab=contacts&integration=int_1");
  });

  it("preserves the tab and the connection on a later page", () => {
    expect(
      buildDataHref("/catalog", {
        tab: "features",
        integration: "int_1",
        page: 2,
      })
    ).toBe("/catalog?tab=features&integration=int_1&page=2");
  });

  it("percent-encodes an id rather than pasting it into the URL", () => {
    expect(buildDataHref("/billing", { integration: "a b&c" })).toBe(
      "/billing?integration=a+b%26c"
    );
  });
});

describe("pageCount", () => {
  it("is at least one page even with no rows", () => {
    expect(pageCount(0)).toBe(1);
  });

  it("rounds up, including exact multiples", () => {
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(PAGE_SIZE * 2)).toBe(2);
    expect(pageCount(PAGE_SIZE * 2 + 1)).toBe(3);
  });
});
