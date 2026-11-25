/**
 * The communication split, pinned.
 *
 * One function owns two source-specific message objects. Each provider's
 * handler declares exactly one, so the mapping editor can never offer Gmail
 * fields to Slack or the reverse. The function's declared `dataModels` must
 * stay aligned with the objects the sync actually writes.
 */

import { describe, expect, it } from "vitest";

import { bootstrap, COMMUNICATION_FUNCTION } from "@/core/bootstrap";
import { getSyncHandler } from "@/core/registries/handler-registry";
import { functionRegistry } from "@/core/registries/function-registry";
import {
  OBJECT_SCHEMAS,
  objectsForFunction,
  schemasForFunction,
} from "@/core/object-schema";
import { gmailFieldDiscovery } from "@/core/providers/gmail/discovery";
import { slackFieldDiscovery } from "@/core/providers/slack/discovery";

bootstrap();

describe("the communication schema split", () => {
  it("owns email and Slack messages as separate objects", () => {
    expect(objectsForFunction(COMMUNICATION_FUNCTION)).toEqual([
      "emailMessage",
      "slackMessage",
    ]);
  });

  it("agrees with what the function declares it syncs", () => {
    expect(
      [...functionRegistry.require(COMMUNICATION_FUNCTION).dataModels].sort()
    ).toEqual([...objectsForFunction(COMMUNICATION_FUNCTION)].sort());
  });

  it("requires the fields each writer rejects a record for", () => {
    const required = (object: "emailMessage" | "slackMessage") =>
      OBJECT_SCHEMAS[object].fields
        .filter((field) => field.required === true)
        .map((field) => field.name)
        .sort();

    expect(required("emailMessage")).toEqual(["direction", "sentAt"]);
    expect(required("slackMessage")).toEqual([
      "authorId",
      "direction",
      "sentAt",
      "threadRootTs",
    ]);
  });

  it("does not offer email address or subject fields on a Slack message", () => {
    const slack = OBJECT_SCHEMAS.slackMessage.fields.map((field) => field.name);
    expect(slack).not.toContain("fromEmail");
    expect(slack).not.toContain("toEmails");
    expect(slack).not.toContain("ccEmails");
    expect(slack).not.toContain("subject");
    expect(slack).not.toContain("bodyHtml");
  });

  it("gives each provider's handler only the object it writes", () => {
    expect(getSyncHandler(COMMUNICATION_FUNCTION, "gmail")?.objects).toEqual([
      "emailMessage",
    ]);
    expect(getSyncHandler(COMMUNICATION_FUNCTION, "slack")?.objects).toEqual([
      "slackMessage",
    ]);
    expect(
      schemasForFunction(COMMUNICATION_FUNCTION).map((schema) => schema.object)
    ).toEqual(["emailMessage", "slackMessage"]);
  });

  it("discovers fields only for the object the provider writes", async () => {
    const ctx = {
      integrationId: "integration",
      accessToken: "token",
      metadata: {},
    };

    await expect(gmailFieldDiscovery.discover(ctx, "emailMessage")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "fromEmail" })])
    );
    await expect(slackFieldDiscovery.discover(ctx, "slackMessage")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "threadRootTs" })])
    );
    await expect(gmailFieldDiscovery.discover(ctx, "slackMessage")).resolves.toEqual(
      []
    );
    await expect(slackFieldDiscovery.discover(ctx, "emailMessage")).resolves.toEqual(
      []
    );
  });
});
