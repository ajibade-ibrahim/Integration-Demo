import { describe, expect, it } from "vitest";
import {
  buildQuery,
  buildSelectList,
  isSafeFieldPath,
} from "@/core/providers/salesforce/soql";

describe("isSafeFieldPath", () => {
  it("accepts identifiers and relationship traversals", () => {
    for (const path of [
      "Name",
      "AccountId",
      "Account_Tier__c",
      "Owner.Name",
      "Account.Owner.Profile.Name",
    ]) {
      expect(isSafeFieldPath(path), path).toBe(true);
    }
  });

  it("rejects anything that could alter the query", () => {
    for (const path of [
      "Name FROM Account WHERE Id != null--",
      "Name, (SELECT Id FROM Contacts)",
      "Name)",
      "Name'",
      "COUNT(Id)",
      "1Name",
      "",
      " Name",
      "Name;",
      "*",
    ]) {
      expect(isSafeFieldPath(path), path).toBe(false);
    }
  });

  it("rejects traversal beyond Salesforce's five-level limit", () => {
    expect(isSafeFieldPath("A.B.C.D.E")).toBe(true);
    expect(isSafeFieldPath("A.B.C.D.E.F")).toBe(false);
  });
});

describe("buildSelectList", () => {
  it("puts required fields first and keeps mapped ones in order", () => {
    const result = buildSelectList(["Email", "Title"], ["Id", "AccountId"]);
    expect(result.fields).toEqual(["Id", "AccountId", "Email", "Title"]);
    expect(result.rejected).toEqual([]);
  });

  it("does not duplicate a field the user also mapped", () => {
    // Case-insensitively: SOQL does not care, and a duplicated column is a
    // query error on some objects.
    const result = buildSelectList(["id", "Name"], ["Id"]);
    expect(result.fields).toEqual(["Id", "Name"]);
  });

  it("reports what it refused instead of dropping it silently", () => {
    const result = buildSelectList(
      ["Name", "Name FROM Account WHERE Id != null--"],
      ["Id"]
    );
    expect(result.fields).toEqual(["Id", "Name"]);
    expect(result.rejected).toEqual(["Name FROM Account WHERE Id != null--"]);
  });

  it("still produces a valid query when every mapped field is refused", () => {
    const result = buildSelectList(["'; DROP"], ["Id"]);
    expect(buildQuery("Account", result.fields)).toBe("SELECT Id FROM Account");
  });
});
