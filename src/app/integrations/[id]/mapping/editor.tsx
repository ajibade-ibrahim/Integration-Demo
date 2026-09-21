"use client";

/**
 * The mapping editor.
 *
 * Both dropdowns are populated from authority rather than hardcoded lists: the
 * source options come from the provider's own schema API (via discovery), and
 * the target options come from `identity-schema`, the same object the validator
 * and the sync engine read. Neither list can drift from what actually works.
 *
 * Sources stay free-text-capable. Discovery can fail, be stale, or omit a field
 * the user knows exists, and a dropdown that cannot express a valid mapping is
 * worse than one with an escape hatch.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FIELD_TRANSFORMS, type FieldTransform } from "@/core/types/mapping";
import type { TargetObject } from "@/core/types/common";

export interface EditorField {
  path: string;
  label: string;
  type: string;
}

export interface EditorTarget {
  name: string;
  label: string;
  required?: boolean;
  kind: string;
  enumValues?: readonly string[];
}

export interface EditorObject {
  object: TargetObject;
  label: string;
  sources: EditorField[];
  targets: EditorTarget[];
  /**
   * Providers this object may hold a cross-reference to — empty when the object
   * accepts none, which is what keeps the option off the contact rows.
   *
   * A dropdown rather than the free-text input custom fields get, because the
   * two constraints are opposite: a custom field key is whatever the user
   * wants, while a cross-reference segment must name a registered provider or
   * it fails validation on save. Offering text here would only let someone type
   * something that cannot work.
   */
  crossRefProviders: { name: string; label: string }[];
}

export interface EditorRule {
  sourceFieldPath: string;
  targetObject: TargetObject;
  targetFieldPath: string;
  transform: FieldTransform;
}

const CUSTOM_FIELD_OPTION = "__custom__";
const CROSS_REF_OPTION = "__crossRef__";

/** Mirrors `CROSS_REF_PATTERN`'s prefix; the server validates the whole path. */
const CROSS_REF_PREFIX = "crossRef.";

const TRANSFORM_LABELS: Record<FieldTransform, string> = {
  none: "None",
  trim: "Trim whitespace",
  lowercase: "Lowercase",
  domainFromUrl: "Domain from URL",
  dateOnly: "Date only",
};

/**
 * Translate a target-dropdown selection into a target path.
 *
 * The cross-reference case pre-selects the first candidate provider rather than
 * leaving a bare `crossRef.`, so the row is never in a state that would be
 * rejected on save with a message about a field that does not exist. The
 * provider dropdown underneath shows what was chosen and is one click to
 * change.
 */
function nextTargetPath(selection: string, object: EditorObject): string {
  if (selection === CUSTOM_FIELD_OPTION) return "customFields.";
  if (selection === CROSS_REF_OPTION) {
    return `${CROSS_REF_PREFIX}${object.crossRefProviders[0]?.name ?? ""}`;
  }
  return selection;
}

/** Rows carry a stable key so React does not reorder inputs as rules change. */
interface Row extends EditorRule {
  key: string;
}

let rowCounter = 0;
function toRows(rules: readonly EditorRule[]): Row[] {
  return rules.map((rule) => ({ ...rule, key: `r${(rowCounter += 1)}` }));
}

export function MappingEditor({
  integrationId,
  functionName,
  objects,
  initialRules,
  suggested,
  discoveryError,
}: {
  integrationId: string;
  functionName: string;
  objects: EditorObject[];
  initialRules: EditorRule[];
  suggested: EditorRule[];
  discoveryError?: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => toRows(initialRules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(key: string, patch: Partial<EditorRule>): void {
    setSaved(false);
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row))
    );
  }

  function addRow(object: TargetObject): void {
    setSaved(false);
    setRows((current) => [
      ...current,
      {
        key: `r${(rowCounter += 1)}`,
        sourceFieldPath: "",
        targetObject: object,
        targetFieldPath: "",
        transform: "none",
      },
    ]);
  }

  function removeRow(key: string): void {
    setSaved(false);
    setRows((current) => current.filter((row) => row.key !== key));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch(
        `/api/integrations/${integrationId}/mapping?function=${functionName}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            rules: rows.map(({ key: _key, ...rule }) => rule),
          }),
        }
      );

      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not save the mapping");
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {discoveryError !== undefined && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Could not read this provider&apos;s field list ({discoveryError}). You
          can still type source field paths by hand.
        </p>
      )}

      {objects.map((object) => (
        <ObjectSection
          key={object.object}
          object={object}
          rows={rows.filter((row) => row.targetObject === object.object)}
          onUpdate={update}
          onRemove={removeRow}
          onAdd={() => {
            addRow(object.object);
          }}
        />
      ))}

      {error !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Mapping saved. The next sync will use it.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save mapping"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRows(toRows(suggested));
            setSaved(false);
          }}
          disabled={suggested.length === 0}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-40"
        >
          Reset to suggested
        </button>
        <span className="text-sm text-slate-500">
          {rows.length} rule{rows.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function ObjectSection({
  object,
  rows,
  onUpdate,
  onRemove,
  onAdd,
}: {
  object: EditorObject;
  rows: Row[];
  onUpdate: (key: string, patch: Partial<EditorRule>) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="font-medium">{object.label}</h2>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-50"
        >
          Add field
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No fields mapped. Nothing will be written to {object.label}.
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          <div className="grid grid-cols-[1fr_1fr_180px_40px] gap-3 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span>Source field</span>
            <span>Target field</span>
            <span>Transform</span>
            <span />
          </div>

          {rows.map((row) => (
            <RuleRow
              key={row.key}
              row={row}
              object={object}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RuleRow({
  row,
  object,
  onUpdate,
  onRemove,
}: {
  row: Row;
  object: EditorObject;
  onUpdate: (key: string, patch: Partial<EditorRule>) => void;
  onRemove: (key: string) => void;
}) {
  const isCustom = row.targetFieldPath.startsWith("customFields.");
  const isCrossRef = row.targetFieldPath.startsWith(CROSS_REF_PREFIX);

  // A source the provider did not report is still legitimate — a stale cache or
  // a permission gap should not make an existing rule uneditable.
  const sourceKnown =
    row.sourceFieldPath === "" ||
    object.sources.some((f) => f.path === row.sourceFieldPath);

  return (
    <div className="grid grid-cols-[1fr_1fr_180px_40px] items-start gap-3 px-4 py-3">
      <div className="space-y-1">
        {object.sources.length > 0 && (
          <select
            value={sourceKnown ? row.sourceFieldPath : ""}
            onChange={(event) => {
              onUpdate(row.key, { sourceFieldPath: event.target.value });
            }}
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Select or type below…</option>
            {object.sources.map((field) => (
              <option key={field.path} value={field.path}>
                {field.label} ({field.path})
              </option>
            ))}
          </select>
        )}
        <input
          value={row.sourceFieldPath}
          onChange={(event) => {
            onUpdate(row.key, { sourceFieldPath: event.target.value });
          }}
          placeholder="properties.domain"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[13px]"
        />
      </div>

      <div className="space-y-1">
        <select
          value={
            isCustom
              ? CUSTOM_FIELD_OPTION
              : isCrossRef
                ? CROSS_REF_OPTION
                : row.targetFieldPath
          }
          onChange={(event) => {
            onUpdate(row.key, {
              targetFieldPath: nextTargetPath(event.target.value, object),
            });
          }}
          className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">Select a target…</option>
          {object.targets.map((target) => (
            <option key={target.name} value={target.name}>
              {target.label}
              {target.required === true ? " (required)" : ""}
            </option>
          ))}
          <option value={CUSTOM_FIELD_OPTION}>Custom field…</option>
          {object.crossRefProviders.length > 0 && (
            <option value={CROSS_REF_OPTION}>Same company in…</option>
          )}
        </select>

        {isCustom && (
          <input
            value={row.targetFieldPath.slice("customFields.".length)}
            onChange={(event) => {
              onUpdate(row.key, {
                targetFieldPath: `customFields.${event.target.value}`,
              });
            }}
            placeholder="account_tier"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[13px]"
          />
        )}

        {isCrossRef && (
          <>
            <select
              value={row.targetFieldPath.slice(CROSS_REF_PREFIX.length)}
              onChange={(event) => {
                onUpdate(row.key, {
                  targetFieldPath: `${CROSS_REF_PREFIX}${event.target.value}`,
                });
              }}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Select a provider…</option>
              {object.crossRefProviders.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              Maps that provider&apos;s own id for this company, joining the two
              records even when they share no email or domain.
            </p>
          </>
        )}
      </div>

      <select
        value={row.transform}
        onChange={(event) => {
          onUpdate(row.key, {
            transform: event.target.value as FieldTransform,
          });
        }}
        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
      >
        {FIELD_TRANSFORMS.map((transform) => (
          <option key={transform} value={transform}>
            {TRANSFORM_LABELS[transform]}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => {
          onRemove(row.key);
        }}
        aria-label="Remove rule"
        className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-500 hover:bg-red-50 hover:text-red-700"
      >
        ×
      </button>
    </div>
  );
}
