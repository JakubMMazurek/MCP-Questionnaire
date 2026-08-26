/**
 * Path resolution against a schema (DESIGN.html §4.5).
 *
 * Resolution answers two questions the validator and the renderer both need:
 * does this path address something the form actually declares, and what kind of
 * thing is it? Every failure carries a teaching message — the §6.3 loop only
 * converges if the agent is told what to write instead.
 *
 * The rule that prevents silent corruption: an ordinal may never address a row
 * of a `repeatable`, `table` or `rank`. Positions shift when the user adds or
 * deletes rows; anchored notes would silently re-point.
 */

import { canonicalPath, formatPath, type ParsedPath, type PathStep, parsePath } from "./paths.js";
import type {
  AllocationField,
  Field,
  Form,
  MatrixField,
  Member,
  Option,
  RankField,
  Section,
} from "./types.js";
import {
  type ContainerField,
  containerChains,
  containerMembers,
  isContainer,
  topLevelFields,
} from "./walk.js";

/** A row scope for `$self` / `$parent`, outermost container first. */
export type Scope = {
  chain: ContainerField[];
  /** Concrete row ids, aligned with `chain`. Absent at schema-validation time. */
  rowIds?: (string | undefined)[];
};

export type ResolvedTarget =
  | { kind: "section"; section: Section }
  | {
      kind: "field";
      field: Field;
      section: Section;
      /** Set when the field is a `table` column or `repeatable` sub-field. */
      container?: ContainerField;
      /** Set when the path addressed one specific row. */
      rowId?: string;
    }
  | { kind: "row"; container: ContainerField; rowId: string; section: Section }
  | { kind: "matrix_row"; field: MatrixField; row: Member; section: Section }
  | {
      kind: "matrix_cell";
      field: MatrixField;
      row: Member;
      col: Member;
      section: Section;
    }
  | { kind: "rank_item"; field: RankField; item: Member; section: Section }
  | {
      kind: "allocation_member";
      field: AllocationField;
      member: Member;
      section: Section;
    };

export type ResolveErrorCode =
  | "unparsable"
  | "unknown_root"
  | "root_ambiguous"
  | "self_out_of_scope"
  | "parent_out_of_scope"
  | "ordinal_row"
  | "ordinal_member"
  | "unknown_member"
  | "not_addressable";

export type ResolveError = {
  code: ResolveErrorCode;
  /** The path as written. */
  path: string;
  message: string;
};

export type ResolveSuccess = {
  ok: true;
  target: ResolvedTarget;
  parsed: ParsedPath;
  /** Syntax-independent key: `a[b][c]`. Equal paths get equal keys. */
  canonical: string;
  /**
   * Container ids a `$self`/`$parent` path also resolves in. Non-empty means the
   * path is ambiguous across rows — legal, but worth a warning.
   */
  alsoResolvesIn: string[];
};

export type ResolveResult = ResolveSuccess | { ok: false; error: ResolveError };

const MAX_LISTED = 12;

/**
 * Stands in for a row id when a `$self` path is resolved against the schema
 * rather than against a rendered row: at validation time no row exists yet.
 */
const ANY_ROW = "$row";

/** The section the outermost container of a scope chain lives in. */
function sectionOfChain(form: Form, chain: readonly ContainerField[]): Section {
  const outermost = chain[0];
  const found = outermost
    ? form.sections.find((section) => section.fields.includes(outermost))
    : undefined;
  // A validated form always has at least one section (§4.8, enforced by shape.ts).
  return found ?? (form.sections[0] as Section);
}

function list(ids: readonly string[]): string {
  if (ids.length === 0) return "(none)";
  const shown = ids.slice(0, MAX_LISTED).map((id) => `"${id}"`);
  return ids.length > MAX_LISTED
    ? `${shown.join(", ")}, … (${ids.length} total)`
    : shown.join(", ");
}

function memberIds(members: readonly Member[]): string[] {
  return members.map((m) => m.id);
}

function fieldMemberSummary(container: ContainerField): string {
  const kind = container.type === "repeatable" ? "sub-fields" : "columns";
  return `"${container.id}" (${kind}: ${list(containerMembers(container).map((f) => f.id))})`;
}

const err = (code: ResolveErrorCode, path: string, message: string): ResolveResult => ({
  ok: false,
  error: { code, path, message },
});

/** Options a target offers, or `null` when it is not an option-bearing target. */
export function optionsOf(target: ResolvedTarget): Option[] | null {
  if (target.kind === "field") {
    const f = target.field;
    if (f.type === "single_select" || f.type === "multi_select") return f.options;
    if (f.type === "matrix") return f.cellOptions ?? [];
    if (f.type === "date" || f.type === "date_range") return f.presets ?? null;
    return null;
  }
  if (target.kind === "matrix_cell" || target.kind === "matrix_row") {
    return target.field.cellOptions ?? [];
  }
  return null;
}

/** True when a target holds a number `sum` could add. */
export function isNumericTarget(target: ResolvedTarget): boolean {
  if (target.kind === "allocation_member") return true;
  if (target.kind === "matrix_cell" || target.kind === "matrix_row") {
    return target.field.cellType === "number";
  }
  if (target.kind !== "field") return false;
  const t = target.field.type;
  return t === "number" || t === "slider" || t === "allocation";
}

/** A short human name for a target, for use inside error messages. */
export function describeTarget(target: ResolvedTarget): string {
  switch (target.kind) {
    case "section":
      return `section "${target.section.id}"`;
    case "field":
      return `field "${target.field.id}" of type "${target.field.type}"`;
    case "row":
      return `row "${target.rowId}" of "${target.container.id}"`;
    case "matrix_row":
      return `row "${target.row.id}" of matrix "${target.field.id}"`;
    case "matrix_cell":
      return `cell [${target.row.id}][${target.col.id}] of matrix "${target.field.id}"`;
    case "rank_item":
      return `item "${target.item.id}" of rank "${target.field.id}"`;
    case "allocation_member":
      return `member "${target.member.id}" of allocation "${target.field.id}"`;
  }
}

type Cursor =
  | { t: "section"; section: Section }
  | {
      t: "field";
      field: Field;
      section: Section;
      container?: ContainerField;
      rowId?: string;
    }
  | { t: "row"; container: ContainerField; rowId: string; section: Section }
  | { t: "matrix_row"; field: MatrixField; row: Member; section: Section }
  | { t: "terminal"; target: ResolvedTarget };

function cursorToTarget(cursor: Cursor): ResolvedTarget {
  switch (cursor.t) {
    case "section":
      return { kind: "section", section: cursor.section };
    case "field":
      return {
        kind: "field",
        field: cursor.field,
        section: cursor.section,
        ...(cursor.container ? { container: cursor.container } : {}),
        ...(cursor.rowId !== undefined ? { rowId: cursor.rowId } : {}),
      };
    case "row":
      return {
        kind: "row",
        container: cursor.container,
        rowId: cursor.rowId,
        section: cursor.section,
      };
    case "matrix_row":
      return {
        kind: "matrix_row",
        field: cursor.field,
        row: cursor.row,
        section: cursor.section,
      };
    case "terminal":
      return cursor.target;
  }
}

function ordinalRowMessage(source: string, container: ContainerField, step: PathStep): string {
  const kind = container.type === "repeatable" ? "repeatable" : "table";
  const member = containerMembers(container)[0]?.id;
  const example = `${container.id}[r_7f3a]${member ? `.${member}` : ""}`;
  return (
    `Path "${source}" addresses row ${step.id} of the ${kind} "${container.id}" by position. ` +
    `Rows of a ${kind} are user-mutable, so positions shift: deleting a row would silently re-point ` +
    `every path anchored at [${step.id}], including notes. Use the minted row id instead — "${example}". ` +
    `Ordinals are for display, never for persistence (§4.5).`
  );
}

/** Steps one level in from a field. */
function stepIntoField(
  source: string,
  field: Field,
  section: Section,
  step: PathStep,
  rowIdOfCursor: string | undefined,
): { ok: true; cursor: Cursor } | { ok: false; result: ResolveResult } {
  switch (field.type) {
    case "repeatable":
    case "table": {
      const members = containerMembers(field);
      const member = members.find((m) => m.id === step.id);
      if (member) {
        // The whole column / sub-field, across every row.
        return {
          ok: true,
          cursor: { t: "field", field: member, section, container: field },
        };
      }
      if (step.ordinal) {
        return {
          ok: false,
          result: err("ordinal_row", source, ordinalRowMessage(source, field, step)),
        };
      }
      return {
        ok: true,
        cursor: { t: "row", container: field, rowId: step.id, section },
      };
    }
    case "matrix": {
      const row = field.rows.find((r) => r.id === step.id);
      if (row) return { ok: true, cursor: { t: "matrix_row", field, row, section } };
      const hint = step.ordinal
        ? ` Matrix rows are agent-declared ids that are fixed for the life of the view — "${step.id}" looks like a position, not an id.`
        : "";
      return {
        ok: false,
        result: err(
          step.ordinal ? "ordinal_member" : "unknown_member",
          source,
          `Path "${source}" addresses row "${step.id}" of matrix "${field.id}", which declares no such row.${hint} Declared rows: ${list(memberIds(field.rows))}.`,
        ),
      };
    }
    case "rank": {
      const item = field.items.find((i) => i.id === step.id);
      if (item) {
        return {
          ok: true,
          cursor: {
            t: "terminal",
            target: { kind: "rank_item", field, item, section },
          },
        };
      }
      const hint = step.ordinal
        ? ` In a rank field the position IS the value being edited, so it can never also be the address (§4.5) — address the item by its declared id.`
        : "";
      return {
        ok: false,
        result: err(
          step.ordinal ? "ordinal_row" : "unknown_member",
          source,
          `Path "${source}" addresses "${step.id}" in rank field "${field.id}", which declares no such item.${hint} Declared items: ${list(memberIds(field.items))}.`,
        ),
      };
    }
    case "allocation": {
      const member = field.members.find((m) => m.id === step.id);
      if (member) {
        return {
          ok: true,
          cursor: {
            t: "terminal",
            target: { kind: "allocation_member", field, member, section },
          },
        };
      }
      return {
        ok: false,
        result: err(
          "unknown_member",
          source,
          `Path "${source}" addresses "${step.id}" in allocation field "${field.id}", which declares no such member. Declared members: ${list(memberIds(field.members))}.`,
        ),
      };
    }
    default: {
      const addressed = rowIdOfCursor !== undefined ? ` (row "${rowIdOfCursor}")` : "";
      return {
        ok: false,
        result: err(
          "not_addressable",
          source,
          `Path "${source}" continues past "${field.id}"${addressed}, a field of type "${field.type}", which has no addressable members. Address it as "${field.id}" (plus a row id if it sits inside a repeatable or table).`,
        ),
      };
    }
  }
}

function stepFrom(
  source: string,
  cursor: Cursor,
  step: PathStep,
): { ok: true; cursor: Cursor } | { ok: false; result: ResolveResult } {
  switch (cursor.t) {
    case "section": {
      const field = cursor.section.fields.find((f) => f.id === step.id);
      if (field) {
        return {
          ok: true,
          cursor: { t: "field", field, section: cursor.section },
        };
      }
      return {
        ok: false,
        result: err(
          "unknown_member",
          source,
          `Path "${source}" addresses "${step.id}" inside section "${cursor.section.id}", which declares no such field. Fields are addressed by their own id from the root — write "${step.id}" — and section ids are addressed alone, as a rule target. Fields in this section: ${list(cursor.section.fields.map((f) => f.id))}.`,
        ),
      };
    }
    case "field":
      return stepIntoField(source, cursor.field, cursor.section, step, cursor.rowId);
    case "row": {
      const members = containerMembers(cursor.container);
      const member = members.find((m) => m.id === step.id);
      if (member) {
        return {
          ok: true,
          cursor: {
            t: "field",
            field: member,
            section: cursor.section,
            container: cursor.container,
            rowId: cursor.rowId,
          },
        };
      }
      const kind = cursor.container.type === "repeatable" ? "sub-field" : "column";
      const hint = step.ordinal
        ? ` ${kind === "column" ? "Columns" : "Sub-fields"} are declared once, so they are addressed by their declared id, never by position.`
        : "";
      return {
        ok: false,
        result: err(
          step.ordinal ? "ordinal_member" : "unknown_member",
          source,
          `Path "${source}" addresses ${kind} "${step.id}" of "${cursor.container.id}", which declares no such ${kind}.${hint} Declared: ${list(members.map((f) => f.id))}.`,
        ),
      };
    }
    case "matrix_row": {
      const col = cursor.field.cols.find((c) => c.id === step.id);
      if (col) {
        return {
          ok: true,
          cursor: {
            t: "terminal",
            target: {
              kind: "matrix_cell",
              field: cursor.field,
              row: cursor.row,
              col,
              section: cursor.section,
            },
          },
        };
      }
      return {
        ok: false,
        result: err(
          step.ordinal ? "ordinal_member" : "unknown_member",
          source,
          `Path "${source}" addresses column "${step.id}" of matrix "${cursor.field.id}", which declares no such column. Declared columns: ${list(memberIds(cursor.field.cols))}.`,
        ),
      };
    }
    case "terminal":
      return {
        ok: false,
        result: err(
          "not_addressable",
          source,
          `Path "${source}" continues past ${describeTarget(cursor.target)}, which has no addressable members.`,
        ),
      };
  }
}

function resolveWithScope(form: Form, parsed: ParsedPath, scope: Scope | undefined): ResolveResult {
  const source = formatPath(parsed);
  let cursor: Cursor;

  if (parsed.head.kind === "id") {
    const id = parsed.head.id;
    const field = topLevelFields(form).find((entry) => entry.field.id === id);
    const section = form.sections.find((s) => s.id === id);
    if (field && section) {
      return err(
        "root_ambiguous",
        source,
        `Path "${source}" is ambiguous: "${id}" is both a section id and a field id. Rename one — a bare path must address exactly one thing.`,
      );
    }
    if (field) {
      cursor = { t: "field", field: field.field, section: field.section };
    } else if (section) {
      cursor = { t: "section", section };
    } else {
      return err(
        "unknown_root",
        source,
        `Path "${source}" does not resolve: this form declares no top-level field or section with id "${id}". Declared field ids: ${list(topLevelFields(form).map((e) => e.field.id))}. Declared section ids: ${list(form.sections.map((s) => s.id))}. Sub-fields and table columns are reached through their container, as in "stakeholders[r_7f3a].owner".`,
      );
    }
  } else {
    const chain = scope?.chain ?? [];
    const innermost = chain.at(-1);
    if (!innermost) {
      return err(
        parsed.head.kind === "self" ? "self_out_of_scope" : "parent_out_of_scope",
        source,
        `Path "${source}" uses "$${parsed.head.kind}", which only has a meaning inside a repeatable or table row (§4.6). This form declares no repeatable or table field, so there is no row scope — address the field directly by its id.`,
      );
    }
    const section = sectionOfChain(form, chain);
    if (parsed.head.kind === "self") {
      cursor = {
        t: "row",
        container: innermost,
        rowId: scope?.rowIds?.at(-1) ?? ANY_ROW,
        section,
      };
    } else {
      const outer = chain.at(-2);
      if (outer) {
        cursor = {
          t: "row",
          container: outer,
          rowId: scope?.rowIds?.at(-2) ?? ANY_ROW,
          section,
        };
      } else {
        // One level up from the outermost row is the container field itself.
        cursor = { t: "field", field: innermost, section };
      }
    }
  }

  for (const step of parsed.steps) {
    const next = stepFrom(source, cursor, step);
    if (!next.ok) return next.result;
    cursor = next.cursor;
  }

  return {
    ok: true,
    target: cursorToTarget(cursor),
    parsed,
    canonical: canonicalPath(parsed),
    alsoResolvesIn: [],
  };
}

export type ResolveOptions = {
  /**
   * The row scope a `$self`/`$parent` path is interpreted in. Omit at schema
   * validation time: every container in the form is then tried, which is what
   * makes a flat `$self` rule checkable without knowing the runtime row.
   */
  scope?: Scope;
};

/**
 * Resolves a §4.5 path against a form.
 *
 * `$self`/`$parent` with no explicit scope resolve against every container in
 * the form; success in at least one container is enough, and the others are
 * reported in `alsoResolvesIn` so the caller can warn about ambiguity.
 */
export function resolvePath(form: Form, source: string, options?: ResolveOptions): ResolveResult {
  const parsedResult = parsePath(source);
  if (!parsedResult.ok) {
    return err("unparsable", source, parsedResult.error.message);
  }
  const parsed = parsedResult.path;

  if (parsed.head.kind === "id" || options?.scope) {
    return resolveWithScope(form, parsed, options?.scope);
  }

  const chains = containerChains(form);
  if (chains.length === 0) {
    return resolveWithScope(form, parsed, undefined);
  }

  const successes: { result: ResolveSuccess; containerId: string }[] = [];
  const failures: ResolveError[] = [];
  for (const { chain } of chains) {
    const result = resolveWithScope(form, parsed, { chain });
    const containerId = (chain.at(-1) as ContainerField).id;
    if (result.ok) successes.push({ result, containerId });
    else failures.push(result.error);
  }

  const first = successes[0];
  if (first) {
    return {
      ...first.result,
      alsoResolvesIn: successes.slice(1).map((s) => s.containerId),
    };
  }

  const ordinal = failures.find((f) => f.code === "ordinal_row" || f.code === "ordinal_member");
  if (ordinal) return { ok: false, error: ordinal };

  return err(
    "self_out_of_scope",
    formatPath(parsed),
    `Path "${formatPath(parsed)}" does not resolve in any repeatable or table in this form. "$self" is the current row, so the rest of the path must name a sub-field or column of a container. Containers tried: ${chains
      .map(({ chain }) => fieldMemberSummary(chain.at(-1) as ContainerField))
      .join("; ")}.`,
  );
}

/** True when the target is something a rule may show/hide/require. */
export function isRuleTargetable(target: ResolvedTarget): boolean {
  return target.kind !== "row";
}

export { canonicalPath, containerMembers, formatPath, isContainer, parsePath };
