/**
 * Normalization is where a false merge is cheapest to cause and hardest to
 * notice, so these tests lean on the two rules that prevent one: dots are never
 * collapsed, and a mailbox-provider host never becomes a company key.
 *
 * Several inputs are taken verbatim from the shipped fixtures, so the resolver
 * and the record writer are pinned to the same verdict on real data.
 */

import { describe, expect, it } from "vitest";

import {
  EMAIL_PATTERN,
  classifyEmail,
  externalRefValue,
  normalizeDomain,
  normalizeEmail,
  normalizeKeyValue,
} from "@/core/identity/normalize";
import {
  freeEmailDomains,
  isFreeEmailDomain,
} from "@/core/identity/free-email-domains";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    // The literal from tests/integration/stripe-handler.test.ts.
    expect(normalizeEmail("  Billing@Acme.example  ")?.value).toBe(
      "billing@acme.example"
    );
  });

  it("strips a plus tag, which is often added by the integration itself", () => {
    expect(normalizeEmail("dana+stripe@acme.example")?.value).toBe(
      "dana@acme.example"
    );
    expect(normalizeEmail("dana+stripe@acme.example")?.localPart).toBe("dana");
  });

  it("preserves dots — collapsing them is Gmail-specific", () => {
    // Two different people at every provider that is not Gmail. Merging them
    // would be a worse error than failing to match.
    expect(normalizeEmail("j.smith@acme.example")?.value).not.toBe(
      normalizeEmail("jsmith@acme.example")?.value
    );
  });

  it("rejects an @ inside the local part", () => {
    // EMAIL_PATTERN excludes @ from the local part, so a quoted address is
    // refused outright rather than split. Pinned because the writer applies the
    // same pattern, and the two must agree.
    expect(normalizeEmail('"odd@name"@acme.example')).toBeUndefined();
  });

  it.each([
    ["not-an-email", "mock fixture p-018"],
    ["sasha.brenner@harbour", "metrifox fixture — domain has no dot"],
    ["@acme.example", "empty local part"],
    ["+tag@acme.example", "local part is nothing but a tag"],
    ["dana@acme example", "whitespace in the domain"],
    ["", "empty"],
  ])("rejects %j (%s)", (input) => {
    expect(normalizeEmail(input)).toBeUndefined();
  });

  it("rejects null without throwing", () => {
    expect(normalizeEmail(null)).toBeUndefined();
  });

  it("agrees with EMAIL_PATTERN, the writer's own check", () => {
    // The whole reason the pattern moved into this module: the writer stores
    // what it validates, and the resolver must not then refuse to match it.
    for (const input of ["not-an-email", "sasha.brenner@harbour"]) {
      expect(EMAIL_PATTERN.test(input)).toBe(false);
      expect(normalizeEmail(input)).toBeUndefined();
    }
    for (const input of ["billing@acme.example", "dana.whitfield@acme-mfg.com"]) {
      expect(EMAIL_PATTERN.test(input)).toBe(true);
      expect(normalizeEmail(input)).toBeDefined();
    }
  });
});

describe("classifyEmail", () => {
  it("classifies role addresses, which the fixtures are full of", () => {
    // These are the actual Metrifox fixture addresses, and the spec's own
    // identity-table seeds. They must remain usable keys.
    expect(normalizeEmail("billing@acme.example")?.emailClass).toBe("role");
    expect(normalizeEmail("accounts@northwind.example")?.emailClass).toBe("role");
    expect(normalizeEmail("finance@quanta.example")?.emailClass).toBe("role");
  });

  it("classifies a personal corporate address as corporate", () => {
    expect(normalizeEmail("dana.whitfield@acme-mfg.com")?.emailClass).toBe(
      "corporate"
    );
  });

  it("lets freemail win over role — the host is what generalizes", () => {
    expect(classifyEmail("billing", "gmail.com")).toBe("freemail");
  });
});

describe("normalizeDomain", () => {
  it("extracts a bare host from the shapes the fixtures actually use", () => {
    expect(normalizeDomain("https://www.acme.example/pricing")).toBe(
      "acme.example"
    );
    expect(normalizeDomain("http://northwind-logistics.co.uk")).toBe(
      "northwind-logistics.co.uk"
    );
    // Bare host, no scheme — mock fixture c-003.
    expect(normalizeDomain("belmonthealth.org")).toBe("belmonthealth.org");
    // Odd TLD, deliberately — mock fixture c-005.
    expect(normalizeDomain("https://www.dunmore.retail")).toBe("dunmore.retail");
  });

  it("strips a trailing root dot", () => {
    expect(normalizeDomain("acme.example.")).toBe("acme.example");
  });

  it("refuses a mailbox provider, which is the gmail.com hazard", () => {
    // src/core/providers/stripe/defaults.ts documents that a user can map
    // `email --domainFromUrl--> customer.domain` in one click. As a match key
    // that would merge every unrelated consumer-address customer.
    expect(normalizeDomain("gmail.com")).toBeUndefined();
    expect(normalizeDomain("https://www.gmail.com")).toBeUndefined();
    expect(normalizeDomain("outlook.com")).toBeUndefined();
  });

  it("refuses reserved and documentation domains", () => {
    // Otherwise a test run merges Acme with Northwind.
    expect(normalizeDomain("example.com")).toBeUndefined();
    expect(normalizeDomain("localhost")).toBeUndefined();
  });

  it("refuses a value with no dot, including the raw-string fallback", () => {
    // domainFromUrl falls back to the raw lowercased value when URL throws, so
    // the stored column is not guaranteed to hold a host.
    expect(normalizeDomain("not a url at all")).toBeUndefined();
    expect(normalizeDomain("intranet")).toBeUndefined();
  });

  it("keeps a company's own mail subdomain — no subdomain matching", () => {
    expect(normalizeDomain("mail.acme.example")).toBe("mail.acme.example");
  });

  it("rejects null and blank without throwing", () => {
    expect(normalizeDomain(null)).toBeUndefined();
    expect(normalizeDomain("   ")).toBeUndefined();
  });
});

describe("externalRefValue", () => {
  it("composes provider, scope and id", () => {
    expect(
      externalRefValue({
        providerName: "stripe",
        scope: "",
        externalId: "cus_abc123",
      })
    ).toBe("stripe::cus_abc123");
  });

  it("keeps a tenant scope in the value, so two portals cannot collide", () => {
    const portalA = externalRefValue({
      providerName: "hubspot",
      scope: "hub-1",
      externalId: "12345",
    });
    const portalB = externalRefValue({
      providerName: "hubspot",
      scope: "hub-2",
      externalId: "12345",
    });
    expect(portalA).not.toBe(portalB);
  });

  it("refuses a blank provider or id", () => {
    expect(
      externalRefValue({ providerName: "", scope: "s", externalId: "1" })
    ).toBeUndefined();
    expect(
      externalRefValue({ providerName: "stripe", scope: "s", externalId: "  " })
    ).toBeUndefined();
  });
});

describe("normalizeKeyValue", () => {
  it("dispatches by kind", () => {
    expect(normalizeKeyValue("email", "Dana@Acme.example")).toBe(
      "dana@acme.example"
    );
    expect(normalizeKeyValue("domain", "https://www.acme.example/x")).toBe(
      "acme.example"
    );
    expect(normalizeKeyValue("external_ref", "Stripe::CUS_1")).toBe(
      "stripe::cus_1"
    );
  });
});

describe("the blocklist itself", () => {
  it("is sorted, so an append is reviewable", () => {
    expect([...freeEmailDomains]).toEqual([...freeEmailDomains].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(freeEmailDomains).size).toBe(freeEmailDomains.length);
  });

  it("matches exact hosts only", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    // A company's own mail host must not be swept up by suffix matching.
    expect(isFreeEmailDomain("mail.gmail.com.acme.example")).toBe(false);
  });
});
