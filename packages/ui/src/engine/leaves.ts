/**
 * Leaf enumeration — the set of addresses that can actually hold an answer.
 *
 * Everything downstream is defined over leaves: the effective-value layer, the
 * `computed` ops, the submission payload. A leaf is one cell, not one field: a
 * `table` contributes rows × columns, a `matrix` rows × cols, an `allocation`
 * one per member. `info` and `computed` contribute nothing — they hold no answer.
 *
 * Rows of a `repeatable` do not exist in the schema, so they are supplied at
 * runtime (`rows`, keyed by canonical container path, §4.5).
 */

import type { Field, Form, Option, Section, Value } from "@gather/schema";
import { containerMembers, isContainer } from "@gather/schema";
import { joinPath } from "./paths.js";

/** Runtime rows for every `repeatable` in the form, keyed by container path. */
export type RowMap = Readonly<Record<string, readonly string[]>>;

export type Leaf = {
  /** Canonical path (§4.5). The key for answers, prefill and effects. */
  path: string;
  /** The field definition the value belongs to (the column def for a table). */
  field: Field;
  section: Section;
  /** Canonical path of the top-level field this leaf belongs to. */
  fieldPath: string;
  /** Enclosing container/matrix row, when the leaf sits in one. */
  rowId?: string;
  rowLabel?: string;
  /** Human label for notes and the submission's `{path, label, note}` triples. */
  label: string;
  /** Declared options, when the leaf takes a closed value set. */
  options?: readonly Option[];
  /** Values a per-cell `matrix` constraint restricts this leaf to (§5.5). */
  allowed?: readonly Value[];
  /** Per-cell `matrix` constraint, or a structurally read-only leaf. */
  readOnly?: boolean;
  /** True when `sum` could add this leaf. */
  numeric: boolean;
};

const NUMERIC = new Set(["number", "slider"]);

function optionsOfField(field: Field): readonly Option[] | undefined {
  if (field.type === "single_select" || field.type === "multi_select") return field.options;
  if (field.type === "date" || field.type === "date_range") return field.presets;
  return undefined;
}

function leafOf(
  field: Field,
  path: string,
  label: string,
  section: Section,
  fieldPath: string,
): Leaf {
  const options = optionsOfField(field);
  return {
    path,
    field,
    section,
    fieldPath,
    label,
    numeric: NUMERIC.has(field.type),
    ...(options ? { options } : {}),
  };
}

function rowLabelOf(label: string | undefined, id: string): string {
  return label ?? id;
}

function* leavesOfField(
  field: Field,
  prefix: string,
  section: Section,
  fieldPath: string,
  rows: RowMap,
  row?: { id: string; label: string },
): Generator<Leaf> {
  const withRow = (leaf: Leaf): Leaf =>
    row ? { ...leaf, rowId: row.id, rowLabel: row.label } : leaf;

  switch (field.type) {
    case "info":
    case "computed":
      return;

    case "table": {
      for (const tableRow of field.rows) {
        const label = rowLabelOf(tableRow.label, tableRow.id);
        for (const column of field.columns) {
          if (column.type === "info") continue;
          yield* leavesOfField(
            column,
            joinPath(prefix, tableRow.id, column.id),
            section,
            fieldPath,
            rows,
            { id: tableRow.id, label },
          );
        }
      }
      return;
    }

    case "repeatable": {
      for (const rowId of rows[prefix] ?? []) {
        for (const sub of field.fields) {
          yield* leavesOfField(sub, joinPath(prefix, rowId, sub.id), section, fieldPath, rows, {
            id: rowId,
            label: rowId,
          });
        }
      }
      return;
    }

    case "matrix": {
      for (const matrixRow of field.rows) {
        for (const col of field.cols) {
          const constraint = field.constraints?.find(
            (c) => c.row === matrixRow.id && c.col === col.id,
          );
          yield {
            path: joinPath(prefix, matrixRow.id, col.id),
            field,
            section,
            fieldPath,
            rowId: matrixRow.id,
            rowLabel: matrixRow.label,
            label: `${matrixRow.label} · ${col.label}`,
            numeric: field.cellType === "number",
            ...(field.cellOptions ? { options: field.cellOptions } : {}),
            ...(constraint?.allowed ? { allowed: constraint.allowed } : {}),
            ...(constraint?.readOnly ? { readOnly: true } : {}),
          };
        }
      }
      return;
    }

    case "allocation": {
      for (const member of field.members) {
        yield {
          path: joinPath(prefix, member.id),
          field,
          section,
          fieldPath,
          label: `${field.label} · ${member.label}`,
          numeric: true,
        };
      }
      return;
    }

    default: {
      const label = row ? `${row.label} — ${field.label}` : field.label;
      yield withRow(leafOf(field, prefix, label, section, fieldPath));
    }
  }
}

/** Every answerable address in the form, in declaration order. */
export function formLeaves(form: Form, rows: RowMap = {}): Leaf[] {
  const out: Leaf[] = [];
  for (const section of form.sections) {
    for (const field of section.fields) {
      out.push(...leavesOfField(field, field.id, section, field.id, rows));
    }
  }
  return out;
}

/** Canonical paths of every `repeatable` in the form (the keys of a `RowMap`). */
export function repeatablePaths(form: Form): string[] {
  const out: string[] = [];
  const walk = (field: Field, prefix: string): void => {
    if (field.type === "repeatable") out.push(prefix);
    if (isContainer(field)) {
      // Nested containers are addressed through a row, which only exists at
      // runtime; v1 mints rows for top-level repeatables only.
      for (const member of containerMembers(field)) {
        if (member.type === "repeatable") walk(member, joinPath(prefix, member.id));
      }
    }
  };
  for (const section of form.sections) for (const field of section.fields) walk(field, field.id);
  return out;
}
