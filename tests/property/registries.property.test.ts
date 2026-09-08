/**
 * Property tests for the registries.
 *
 * The scope-isolation property is the one that matters most: the entire premise
 * of the platform is that authorizing an integration for one function cannot
 * request another function's permissions.
 */

import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  functionNamesForProvider,
  providerNamesForFunction,
  registerFunction,
  resolveScopes,
} from "@/core/registries/function-registry";
import { resetBootstrapForTests } from "@/core/bootstrap";
import { functionRegistry } from "@/core/registries/function-registry";

const RUNS = 200;

/** Distinct lowercase identifiers, so generated names never collide by accident. */
const nameArb = fc
  .string({ minLength: 3, maxLength: 12 })
  .map((s) => s.replace(/[^a-z]/gi, "") || "x")
  .map((s) => s.toLowerCase());

const scopeArb = fc
  .tuple(nameArb, nameArb)
  .map(([a, b]) => `${a}.${b}.read`);

interface GeneratedFunction {
  name: string;
  scopesByProvider: Array<[string, string[]]>;
}

/** A registry configuration: several functions across several providers. */
const registryArb = fc
  .tuple(
    fc.uniqueArray(nameArb, { minLength: 2, maxLength: 5 }),
    fc.uniqueArray(nameArb, { minLength: 1, maxLength: 4 })
  )
  .chain(([functionNames, providerNames]) =>
    fc
      .array(
        fc.tuple(
          // Which providers support this function.
          fc.subarray(providerNames),
          fc.uniqueArray(scopeArb, { minLength: 1, maxLength: 4 })
        ),
        { minLength: functionNames.length, maxLength: functionNames.length }
      )
      .map((perFunction): GeneratedFunction[] =>
        functionNames.map((name, i) => {
          const entry = perFunction[i];
          const providers = entry?.[0] ?? [];
          const scopes = entry?.[1] ?? ["default.scope.read"];
          return {
            name,
            // Give each function distinct scope names per provider so an
            // isolation failure is unambiguous.
            scopesByProvider: providers.map((p) => [
              p,
              scopes.map((s) => `${name}:${s}`),
            ]),
          };
        })
      )
  );

function install(functions: GeneratedFunction[]): void {
  for (const f of functions) {
    registerFunction({
      name: f.name,
      label: f.name,
      description: "",
      dataModels: ["customer"],
      scopesByProvider: new Map(f.scopesByProvider),
    });
  }
}

beforeEach(() => {
  resetBootstrapForTests();
});

describe("Property: function-scoped OAuth scope isolation", () => {
  it("requests exactly the selected function's scopes and no other function's", () => {
    fc.assert(
      fc.property(registryArb, (functions) => {
        functionRegistry.clear();
        install(functions);

        for (const target of functions) {
          for (const [provider, expectedScopes] of target.scopesByProvider) {
            const resolved = resolveScopes([target.name], provider);

            // Exactly what the function declares for this provider.
            expect([...resolved].sort()).toEqual([...expectedScopes].sort());

            // Nothing belonging exclusively to another function.
            const foreign = functions
              .filter((f) => f.name !== target.name)
              .flatMap((f) => f.scopesByProvider.flatMap(([, s]) => s))
              .filter((s) => !expectedScopes.includes(s));

            for (const scope of foreign) {
              expect(resolved).not.toContain(scope);
            }
          }
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("resolving multiple functions yields exactly the union of their scopes", () => {
    fc.assert(
      fc.property(registryArb, (functions) => {
        functionRegistry.clear();
        install(functions);

        // Providers supported by more than one function.
        const byProvider = new Map<string, string[]>();
        for (const f of functions) {
          for (const [p] of f.scopesByProvider) {
            byProvider.set(p, [...(byProvider.get(p) ?? []), f.name]);
          }
        }

        for (const [provider, names] of byProvider) {
          if (names.length < 2) continue;

          const union = new Set(
            names.flatMap(
              (n) =>
                functions
                  .find((f) => f.name === n)
                  ?.scopesByProvider.find(([p]) => p === provider)?.[1] ?? []
            )
          );
          expect([...resolveScopes(names, provider)].sort()).toEqual(
            [...union].sort()
          );
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("throws rather than silently requesting nothing for an unsupported pair", () => {
    fc.assert(
      fc.property(registryArb, nameArb, (functions, provider) => {
        functionRegistry.clear();
        install(functions);

        for (const f of functions) {
          const supported = f.scopesByProvider.some(([p]) => p === provider);
          if (supported) continue;
          expect(() => resolveScopes([f.name], provider)).toThrow();
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("Property: provider filtering by function", () => {
  it("lists only providers that declare support for the function", () => {
    fc.assert(
      fc.property(registryArb, (functions) => {
        functionRegistry.clear();
        install(functions);

        for (const f of functions) {
          const listed = providerNamesForFunction(f.name);
          const declared = f.scopesByProvider.map(([p]) => p).sort();

          expect(listed).toEqual(declared);

          // And the inverse view agrees.
          for (const provider of listed) {
            expect(functionNamesForProvider(provider)).toContain(f.name);
          }
        }
      }),
      { numRuns: RUNS }
    );
  });

  it("returns an empty list for an unregistered function", () => {
    expect(providerNamesForFunction("nonexistent")).toEqual([]);
  });
});

describe("Property: registry immutability", () => {
  it("leaves existing entries unchanged when a registration fails", () => {
    fc.assert(
      fc.property(registryArb, (functions) => {
        functionRegistry.clear();
        install(functions);

        const before = functionRegistry
          .getAll()
          .map((f) => f.name)
          .sort();

        // Duplicate name, and structurally invalid definitions.
        const badRegistrations = [
          () => install([functions[0] as GeneratedFunction]),
          () =>
            registerFunction({
              name: "",
              label: "",
              description: "",
              dataModels: ["customer"],
              scopesByProvider: new Map(),
            }),
          () =>
            registerFunction({
              name: "no-models",
              label: "",
              description: "",
              dataModels: [],
              scopesByProvider: new Map(),
            }),
        ];

        for (const attempt of badRegistrations) {
          expect(attempt).toThrow();
        }

        expect(
          functionRegistry
            .getAll()
            .map((f) => f.name)
            .sort()
        ).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  it("hands out copies, so a caller cannot mutate a stored definition", () => {
    functionRegistry.clear();
    registerFunction({
      name: "identity",
      label: "Identity",
      description: "",
      dataModels: ["customer", "contact"],
      scopesByProvider: new Map([["hubspot", ["a.read"]]]),
    });

    const first = functionRegistry.require("identity");
    (first.dataModels as string[]).push("mutated");
    (first.scopesByProvider as Map<string, string[]>).set("evil", ["x"]);

    const second = functionRegistry.require("identity");
    expect(second.dataModels).toEqual(["customer", "contact"]);
    expect(second.scopesByProvider.has("evil")).toBe(false);
  });
});
