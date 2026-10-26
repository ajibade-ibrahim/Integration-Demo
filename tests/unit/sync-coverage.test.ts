/**
 * The run report's second question.
 *
 * Record counts answer "did rows land?". Coverage answers "did we see the whole
 * list, which objects were never yielded, and which supported objects had no
 * mapping?". These tests pin the distinction, especially the tri-state
 * completeness field, so a missing page is never quietly promoted to success.
 */

import { describe, expect, it } from "vitest";

import {
  createFunctionCoverage,
  finishFunctionCoverage,
  recordCoverageIssues,
  recordCoveragePage,
  recordCoverageWrites,
  recordFunctionError,
} from "@/core/sync/coverage";
function identityCoverage(mapped: string[] = ["customer", "contact"]) {
  return createFunctionCoverage({
    functionName: "identity",
    supportedObjects: ["customer", "contact"],
    mappedObjects: new Set(mapped as ("customer" | "contact")[]),
  });
}

describe("function coverage", () => {
  it("separates pages, reads, writes and completeness per object", () => {
    const coverage = identityCoverage();

    recordCoveragePage(coverage, "customer", 2, true);
    recordCoveragePage(coverage, "customer", 1, true);
    recordCoveragePage(coverage, "contact", 1, undefined);
    recordCoverageWrites(coverage, { customer: 3, contact: 1 });
    recordCoverageIssues(coverage, [
      {
        sourceRecordId: "cus_3",
        targetObject: "customer",
        reason: "Malformed email",
        severity: "warning",
      },
      {
        sourceRecordId: "con_2",
        targetObject: "contact",
        reason: "Name is required",
        severity: "rejected",
      },
    ]);
    finishFunctionCoverage(coverage);

    expect(coverage).toMatchObject({
      pages: 3,
      recordsRead: 4,
      recordsWritten: 4,
      warnings: 1,
      rejected: 1,
      omittedObjects: [],
      unmappedObjects: [],
    });

    expect(coverage.objects.find((object) => object.object === "customer"))
      .toMatchObject({
        mapped: true,
        yielded: true,
        pages: 2,
        recordsRead: 3,
        recordsWritten: 3,
        complete: true,
        warnings: 1,
        rejected: 0,
      });
    expect(coverage.objects.find((object) => object.object === "contact"))
      .toMatchObject({
        mapped: true,
        yielded: true,
        pages: 1,
        recordsRead: 1,
        recordsWritten: 1,
        complete: null,
        warnings: 0,
        rejected: 1,
      });
  });

  it("keeps an undeclared page from erasing a previous completeness claim", () => {
    const coverage = identityCoverage();

    recordCoveragePage(coverage, "customer", 1, true);
    recordCoveragePage(coverage, "customer", 1, undefined);
    recordCoveragePage(coverage, "customer", 1, true);
    finishFunctionCoverage(coverage);

    expect(coverage.objects.find((object) => object.object === "customer")?.complete)
      .toBe(true);
  });

  it("marks an object incomplete when any page declares it incomplete", () => {
    const coverage = identityCoverage();

    recordCoveragePage(coverage, "customer", 1, true);
    recordCoveragePage(coverage, "customer", 1, false);
    finishFunctionCoverage(coverage);

    expect(coverage.objects.find((object) => object.object === "customer")?.complete)
      .toBe(false);
  });

  it("reports mapped objects never yielded and supported objects never mapped", () => {
    const omitted = identityCoverage(["customer", "contact"]);
    recordCoveragePage(omitted, "customer", 1, true);
    recordCoverageWrites(omitted, { customer: 1 });
    finishFunctionCoverage(omitted);
    expect(omitted.omittedObjects).toEqual(["contact"]);
    expect(omitted.unmappedObjects).toEqual([]);

    const unmapped = identityCoverage(["customer"]);
    recordCoveragePage(unmapped, "customer", 1, true);
    recordCoverageWrites(unmapped, { customer: 1 });
    finishFunctionCoverage(unmapped);
    expect(unmapped.omittedObjects).toEqual([]);
    expect(unmapped.unmappedObjects).toEqual(["contact"]);
  });

  it("flags the shared page guard when a handler returns without a completeness claim", () => {
    const coverage = identityCoverage(["customer"]);

    for (let page = 0; page < 1000; page++) {
      recordCoveragePage(coverage, "customer", 1, undefined);
    }
    finishFunctionCoverage(coverage);

    expect(coverage.objects[0]?.pages).toBe(1000);
    expect(coverage.objects[0]?.atPageLimit).toBe(true);
    expect(coverage.objects[0]?.complete).toBeNull();
  });

  it("trusts an explicit completeness claim at the page guard", () => {
    const coverage = identityCoverage(["customer"]);

    for (let page = 0; page < 1000; page++) {
      recordCoveragePage(coverage, "customer", 1, true);
    }
    finishFunctionCoverage(coverage);

    expect(coverage.objects[0]?.atPageLimit).toBe(false);
    expect(coverage.objects[0]?.complete).toBe(true);
  });

  it("retains a function error and its partial pages", () => {
    const coverage = identityCoverage(["customer"]);
    recordCoveragePage(coverage, "customer", 2, undefined);
    recordFunctionError(coverage, "Provider returned 500");
    finishFunctionCoverage(coverage);

    expect(coverage.error).toBe("Provider returned 500");
    expect(coverage.objects[0]?.recordsRead).toBe(2);
  });
});
