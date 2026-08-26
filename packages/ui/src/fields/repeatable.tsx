/**
 * `repeatable` — "add another stakeholder" (§4.2).
 *
 * Rows are user-mutable, so their ids are CLIENT-MINTED (`r_7f3a`, §4.5) and the
 * store owns them: deleting row two must not re-point a note anchored under row
 * three. The engine already mints `min` rows at load, re-enumerates leaves on
 * add/remove, and instantiates `$self` rules per row — this file is the UI over
 * that, and nothing here knows about ordinals.
 */

import type { Field, RepeatableField } from "@mcpq/schema";
import { memo } from "react";
import { Button } from "../components/primitives";
import { joinPath } from "../engine/index.js";
import { useActions, useDisabled, useRequired, useRows, useVisible } from "../state";
import { LeafControl } from "./controls";
import { NoteAffordance } from "./note";

const SubField = memo(function SubField({
  path,
  field,
  rowLabel,
}: {
  path: string;
  field: Field;
  rowLabel: string;
}) {
  const visible = useVisible(path);
  const declaredRequired = "required" in field ? field.required : undefined;
  const required = useRequired(path, declaredRequired);
  if (!visible || field.type === "computed") return null;
  const label = ("label" in field && field.label) || field.id;

  if (field.type === "info") {
    return <p className="why m-0">{field.markdown}</p>;
  }

  return (
    <div className="sub-field">
      <span className="sub-label">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="text-muted">
              {" *"}
            </span>
            <span className="sr-only">required</span>
          </>
        ) : null}
      </span>
      <LeafControl path={path} field={field} label={`${rowLabel} — ${label}`} />
    </div>
  );
});

const RepeatableRow = memo(function RepeatableRow({
  containerPath,
  rowId,
  index,
  fields,
  removable,
  label,
}: {
  containerPath: string;
  rowId: string;
  index: number;
  fields: readonly Field[];
  removable: boolean;
  label: string;
}) {
  const actions = useActions();
  const rowPath = joinPath(containerPath, rowId);
  // The ordinal is DISPLAY ONLY (§4.5) — the address is `rowId`.
  const rowLabel = `${label} ${index + 1}`;

  return (
    <div className="repeat-row">
      <div className="repeat-head">
        <span className="rank-position" aria-hidden="true">
          {index + 1}
        </span>
        <span className="grow sr-only">{rowLabel}</span>
        <NoteAffordance path={rowPath} label={rowLabel} />
        {removable ? (
          <button
            type="button"
            className="btn-icon"
            aria-label={`Remove ${rowLabel}`}
            onClick={() => actions.removeRow(containerPath, rowId)}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="repeat-body">
        {fields.map((sub) => (
          <SubField key={sub.id} path={joinPath(rowPath, sub.id)} field={sub} rowLabel={rowLabel} />
        ))}
      </div>
    </div>
  );
});

export const RepeatableFieldView = memo(function RepeatableFieldView({
  field,
  path,
  label,
}: {
  field: RepeatableField;
  path: string;
  label: string;
}) {
  const rows = useRows(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const atMax = field.max !== undefined && rows.length >= field.max;
  const atMin = rows.length <= (field.min ?? 0);

  return (
    <section className="stack" aria-label={label}>
      {rows.map((rowId, index) => (
        <RepeatableRow
          key={rowId}
          containerPath={path}
          rowId={rowId}
          index={index}
          fields={field.fields}
          removable={!disabled && !atMin}
          label={label}
        />
      ))}
      <div className="flex items-center gap-2">
        <Button
          disabled={disabled || atMax}
          {...(atMax ? { title: `At most ${field.max}` } : {})}
          onClick={() => actions.addRow(path)}
        >
          {field.addLabel ?? `Add ${label}`}
        </Button>
        {rows.length === 0 ? <span className="why m-0">Nothing added yet.</span> : null}
      </div>
    </section>
  );
});
