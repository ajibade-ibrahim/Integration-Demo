/**
 * `fieldProvenance` has two shapes in the wild: the current evidence object and
 * the old bare integration id. The read path must accept both, because an
 * account resolved before the richer shape existed has to keep rendering until
 * the next pass rewrites it.
 */

import { describe, expect, it } from "vitest";

import { parseFieldProvenance } from "@/core/identity/provenance";

describe("parseFieldProvenance", () => {
  it("normalizes old string values without inventing source metadata", () => {
    expect(parseFieldProvenance('{"name":"int-stripe"}')).toEqual({
      name: { integrationId: "int-stripe" },
    });
  });

  it("keeps current evidence and losing alternatives", () => {
    const parsed = parseFieldProvenance(
      JSON.stringify({
        industry: {
          integrationId: "int-hubspot",
          providerName: "hubspot",
          instanceLabel: "HubSpot",
          customerId: "customer-1",
          externalSourceId: "123",
          evidenceKey: "industry",
          evidenceValue: "Manufacturing",
          observedAt: "2026-01-01T00:00:00.000Z",
          value: "Manufacturing",
          alternatives: [
            {
              integrationId: "int-stripe",
              customerId: "customer-2",
              externalSourceId: "cus_2",
              value: "Logistics",
              reason: "Lower priority than HubSpot (500 vs 50)",
            },
          ],
        },
      })
    );

    expect(parsed.industry).toMatchObject({
      integrationId: "int-hubspot",
      customerId: "customer-1",
      externalSourceId: "123",
      evidenceKey: "industry",
      value: "Manufacturing",
      alternatives: [
        {
          integrationId: "int-stripe",
          customerId: "customer-2",
          externalSourceId: "cus_2",
          value: "Logistics",
          reason: "Lower priority than HubSpot (500 vs 50)",
        },
      ],
    });
  });

  it("drops malformed entries instead of trusting their shape", () => {
    expect(
      parseFieldProvenance(
        JSON.stringify({
          good: "int-good",
          noId: { value: "orphan" },
          notAnObject: 42,
          nullish: null,
        })
      )
    ).toEqual({ good: { integrationId: "int-good" } });
  });

  it("returns an empty map for invalid JSON", () => {
    expect(parseFieldProvenance("{")).toEqual({});
  });
});
