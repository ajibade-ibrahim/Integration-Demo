/**
 * GET  /api/integrations/[id]/mapping — current rules for a function.
 * PUT  /api/integrations/[id]/mapping — replace them.
 *
 * PUT replaces the whole rule set rather than patching individual rules. A
 * mapping is only meaningful as a set — validation is over the set, and
 * "customer.name is mapped exactly once" is not something a per-rule patch can
 * check. Replacement also makes deletion expressible, which a patch API would
 * need a separate verb for.
 */

import { NextResponse } from "next/server";
import { bootstrap, IDENTITY_FUNCTION } from "@/core/bootstrap";
import { findIntegrationForUser } from "@/core/repositories/integration-repository";
import { currentUserId } from "@/lib/current-user";
import {
  findMappings,
  saveMappings,
} from "@/core/repositories/mapping-repository";
import { defaultMappingsFor } from "@/core/providers/defaults-registry";
import { isTargetObject } from "@/core/types/common";
import { isFieldTransform, type FieldMappingRule } from "@/core/types/mapping";

/**
 * Resolve and authorize the (integration, function) pair a request names.
 *
 * The ownership check lives here rather than in each handler so GET and PUT
 * cannot drift apart — a reader and a writer disagreeing about who may touch a
 * mapping is the kind of gap that only shows up once.
 */
async function resolveTarget(
  id: string,
  url: string
): Promise<
  | { ok: true; functionName: string; providerName: string }
  | { ok: false; response: NextResponse }
> {
  const integration = await findIntegrationForUser(id, await currentUserId());
  if (integration === undefined) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      ),
    };
  }

  const functionName =
    new URL(url).searchParams.get("function") ?? IDENTITY_FUNCTION;

  if (!integration.functionNames.includes(functionName)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `This integration does not serve '${functionName}'`,
          serves: integration.functionNames,
        },
        { status: 400 }
      ),
    };
  }

  return { ok: true, functionName, providerName: integration.providerName };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const target = await resolveTarget(id, request.url);
  if (!target.ok) return target.response;

  const rules = await findMappings(id, target.functionName);

  return NextResponse.json({
    functionName: target.functionName,
    rules,
    // Offered so the editor can show a "reset to suggested" affordance without
    // a second endpoint.
    suggested: defaultMappingsFor(target.functionName, target.providerName),
  });
}

interface PutBody {
  rules?: unknown;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  bootstrap();

  const { id } = await context.params;
  const target = await resolveTarget(id, request.url);
  if (!target.ok) return target.response;

  const body = (await request.json()) as PutBody;
  if (!Array.isArray(body.rules)) {
    return NextResponse.json(
      { error: "Expected a 'rules' array" },
      { status: 400 }
    );
  }

  // Shape-check before handing to the domain validator, which assumes typed
  // input. An untyped body reaching `saveMappings` would fail with a less
  // useful message than this one.
  const rules: FieldMappingRule[] = [];
  for (const [index, entry] of body.rules.entries()) {
    const rule = entry as Record<string, unknown>;

    if (
      typeof rule["sourceFieldPath"] !== "string" ||
      typeof rule["targetFieldPath"] !== "string" ||
      !isTargetObject(rule["targetObject"])
    ) {
      return NextResponse.json(
        { error: `Rule ${index} is missing a source, target, or object` },
        { status: 400 }
      );
    }

    rules.push({
      sourceFieldPath: rule["sourceFieldPath"],
      targetObject: rule["targetObject"],
      targetFieldPath: rule["targetFieldPath"],
      transform: isFieldTransform(rule["transform"]) ? rule["transform"] : "none",
    });
  }

  try {
    // Validated and written in one transaction: a rejected save must leave the
    // previous rules intact rather than half-replaced.
    await saveMappings(id, target.functionName, rules);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not save the mapping",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    functionName: target.functionName,
    rules: await findMappings(id, target.functionName),
  });
}
