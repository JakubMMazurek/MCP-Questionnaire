/**
 * The `table` field — the assumption ledger's shape (§5.1): column definitions
 * declared once, rows as data.
 *
 * Density and layout follow the §5.1 mockup, which the spec makes normative: one
 * dense row per assumption, the row's free text and provenance chip on the left,
 * the primary answer control (a segmented single_select) on the right, the note
 * icon after it, and any FURTHER visible column — the `$self`-revealed
 * correction input — as a labelled full-width sub-row underneath.
 *
 * Every row is a memoized component and every cell subscribes to its own path,
 * so a click re-renders one row at most (§5.5/§8).
 */

import type { TableColumn, TableField, TableRow } from "@gather/schema";
import { memo } from "react";
import { ProvenanceChip } from "../components/primitives";
import { joinPath } from "../engine/index.js";
import { usePrefill, useVisible } from "../state";
import { LeafControl } from "./controls";
import { NoteAffordance } from "./note";

/** Columns that can hold an answer, in declaration order. */
function answerColumns(field: TableField): TableColumn[] {
  return field.columns.filter((column) => column.type !== "info");
}

const Cell = memo(function Cell({
  path,
  column,
  label,
}: {
  path: string;
  column: TableColumn;
  label: string;
}) {
  const visible = useVisible(path);
  if (!visible) return null;
  return <LeafControl path={path} field={column} label={label} />;
});

const SubCell = memo(function SubCell({
  path,
  column,
  rowLabel,
}: {
  path: string;
  column: TableColumn;
  rowLabel: string;
}) {
  const visible = useVisible(path);
  if (!visible) return null;
  return (
    <div className="subrow flex flex-wrap items-center gap-2">
      <span className="text-[length:var(--font-text-xs-size)] text-muted">{column.label}</span>
      <div className="min-w-[16rem] flex-1">
        <LeafControl path={path} field={column} label={`${rowLabel} — ${column.label}`} />
      </div>
    </div>
  );
});

const LedgerRow = memo(function LedgerRow({
  tablePath,
  row,
  primary,
  rest,
}: {
  tablePath: string;
  row: TableRow;
  primary: TableColumn | undefined;
  rest: readonly TableColumn[];
}) {
  const rowPath = joinPath(tablePath, row.id);
  const primaryPath = primary ? joinPath(rowPath, primary.id) : rowPath;
  // Row provenance is not a row property (§5.1, audited): it is the §4.7
  // envelope on the row's primary answer.
  const prefill = usePrefill(primaryPath);
  const label = row.label ?? row.id;

  return (
    <div className="ledger-row">
      <div className="grow">
        <span>{label}</span>
        {prefill ? (
          <>
            {" "}
            <ProvenanceChip prefill={prefill} />
          </>
        ) : null}
        {row.description ? <span className="why">{row.description}</span> : null}
      </div>
      {primary ? (
        <Cell path={primaryPath} column={primary} label={`${label} — ${primary.label}`} />
      ) : null}
      <NoteAffordance path={rowPath} label={label} />
      {rest.map((column) => (
        <SubCell
          key={column.id}
          path={joinPath(rowPath, column.id)}
          column={column}
          rowLabel={label}
        />
      ))}
    </div>
  );
});

export const TableFieldView = memo(function TableFieldView({
  field,
  path,
}: {
  field: TableField;
  path: string;
}) {
  const columns = answerColumns(field);
  const primary = columns[0];
  const rest = columns.slice(1);

  return (
    <section aria-label={field.label}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[length:var(--font-heading-sm-size)] font-[var(--font-weight-semibold)]">
          {field.label}
        </h3>
        {primary ? (
          <span className="text-[length:var(--font-text-xs-size)] text-faint">{primary.label}</span>
        ) : null}
      </div>
      {field.description ? <p className="why m-0">{field.description}</p> : null}
      <div className="mt-1">
        {field.rows.map((row) => (
          <LedgerRow key={row.id} tablePath={path} row={row} primary={primary} rest={rest} />
        ))}
      </div>
    </section>
  );
});
