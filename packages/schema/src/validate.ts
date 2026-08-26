/**
 * The validator (DESIGN.html §6.3).
 *
 * Two passes. `shape.ts` checks structure and the closed vocabularies; this file
 * checks everything that needs the whole form — paths resolving, rule targets,
 * option sets, uniqueness, cycles — and the smells that make a form valid but
 * bad. Errors reject the form; warnings do not.
 *
 * Every message names the location, says what is wrong and says what to write
 * instead. That is the whole reason the §6.3 agent-side loop converges.
 */

import { type Diagnostic, error, formatDiagnostics, warning } from "./diagnostics.js";
import { parsePath } from "./paths.js";
import {
  describeTarget,
  isNumericTarget,
  optionsOf,
  type ResolvedTarget,
  type ResolveResult,
  resolvePath,
} from "./resolve.js";
import { answersSchema, formSchema, zodIssuesToDiagnostics } from "./shape.js";
import type { Answers, Computed, Field, Form, Option, Rule, Section, Value } from "./types.js";
import {
  CARDS_OPTION_SOFT_LIMIT,
  MATRIX_CYCLE_OPTION_LIMIT,
  quoteList,
  SEARCHABLE_LIST_THRESHOLD,
  SECTION_FIELD_SOFT_LIMIT,
  SEGMENTED_OPTION_SOFT_LIMIT,
  TABLE_COLUMN_TYPES,
} from "./vocab.js";
import { containerMembers, walkFields } from "./walk.js";

export type ValidationResult = {
  /** True when there are no errors. Warnings do not gate. */
  ok: boolean;
  /** The typed form, when the shape pass succeeded. */
  form: Form | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Errors first, then warnings. */
  diagnostics: Diagnostic[];
  /** The formatted rendering — this is what goes back to the agent (§6.3). */
  text: string;
};

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

const FORM_ROOT = "(form root)";

function sectionLoc(index: number, section: Section): string {
  return `sections[${index}] "${section.id}"`;
}

function optionValues(options: readonly Option[] | undefined): Value[] {
  return (options ?? []).map((option) => option.value);
}

/** Values a target will accept, or `null` when it is not option-constrained. */
function acceptedValues(target: ResolvedTarget): Value[] | null {
  const skip =
    target.kind === "field" && "skipOptions" in target.field
      ? optionValues(target.field.skipOptions)
      : [];
  if (target.kind === "matrix_cell" || target.kind === "matrix_row") {
    return [...optionValues(target.field.cellOptions), ...optionValues(target.field.skipOptions)];
  }
  if (target.kind !== "field") return null;
  const field = target.field;
  if (field.type === "single_select" || field.type === "multi_select") {
    return [...optionValues(field.options), ...skip];
  }
  if (field.type === "boolean") return [true, false, ...skip];
  return null;
}

function isReadOnly(target: ResolvedTarget): boolean {
  return (
    target.kind === "field" && (target.field.type === "info" || target.field.type === "computed")
  );
}

/**
 * A stable identity for a resolved target, so `$self.status` and
 * `ledger[r_7f3a].status` — the same column, addressed two ways — compare equal.
 */
function targetKey(target: ResolvedTarget): string {
  switch (target.kind) {
    case "section":
      return `section:${target.section.id}`;
    case "field":
      return `field:${target.container ? `${target.container.id}.` : ""}${target.field.id}`;
    case "row":
      return `row:${target.container.id}`;
    case "matrix_row":
      return `matrix_row:${target.field.id}.${target.row.id}`;
    case "matrix_cell":
      return `matrix_cell:${target.field.id}.${target.row.id}.${target.col.id}`;
    case "rank_item":
      return `rank_item:${target.field.id}.${target.item.id}`;
    case "allocation_member":
      return `allocation_member:${target.field.id}.${target.member.id}`;
  }
}

/**
 * True when a prefill path addresses the computed target or something inside
 * it: a matrix cell within its grid, a table cell within its column or table,
 * a sub-field within its repeatable. Same head id, and the target's step ids
 * appearing in order within the prefill path's steps — so `grid` contains
 * `grid[Discount__c][sales_ops]`, and `assumptions.verdict` contains
 * `assumptions[r_eu].verdict`.
 */
function prefillWithinTarget(prefillPath: string, targetPath: string): boolean {
  const p = parsePath(prefillPath);
  const t = parsePath(targetPath);
  if (!p.ok || !t.ok) return false;
  if (p.path.head.kind !== "id" || t.path.head.kind !== "id") return false;
  if (p.path.head.id !== t.path.head.id) return false;
  let matched = 0;
  for (const step of p.path.steps) {
    if (matched < t.path.steps.length && t.path.steps[matched]?.id === step.id) matched += 1;
  }
  return matched === t.path.steps.length;
}

/** Resolves a path, turning any failure into a diagnostic at `location`. */
function resolveOrDiagnose(
  form: Form,
  path: string,
  location: string,
  out: Diagnostic[],
): (ResolveResult & { ok: true }) | null {
  const result = resolvePath(form, path);
  if (result.ok) {
    if (result.alsoResolvesIn.length > 0) {
      out.push(
        warning(
          "self_scope_ambiguous",
          location,
          `Path "${path}" resolves in more than one container — it matches a member of ${quoteList([
            (result.target.kind === "field" && result.target.container?.id) || "?",
            ...result.alsoResolvesIn,
          ])}. At runtime "$self" is the row being edited, so this is legal, but if two containers declare the same member id the rule will fire in both. Rename one member if that is not intended.`,
        ),
      );
    }
    return result;
  }
  const code =
    result.error.code === "ordinal_row" || result.error.code === "ordinal_member"
      ? "ordinal_path"
      : "unresolved_path";
  out.push(error(code, location, result.error.message));
  return null;
}

/* -------------------------------------------------------------------------- */
/* per-field checks                                                           */
/*                                                                            */
/* `location` is the field's structural prefix (`sections[0].fields[2]`); each */
/* check appends the exact property and the field id, so a diagnostic always   */
/* points at one spot in the JSON the agent sent.                             */
/* -------------------------------------------------------------------------- */

function checkDuplicateOptionValues(field: Field, location: string, out: Diagnostic[]): void {
  const groups: { what: string; options: readonly Option[] }[] = [];
  if ("skipOptions" in field && field.skipOptions) {
    groups.push({ what: "skipOptions", options: field.skipOptions });
  }
  if (field.type === "single_select" || field.type === "multi_select") {
    groups.push({ what: "options", options: field.options });
  }
  if (field.type === "date" || field.type === "date_range") {
    if (field.presets) groups.push({ what: "presets", options: field.presets });
  }
  if (field.type === "matrix" && field.cellOptions) {
    groups.push({ what: "cellOptions", options: field.cellOptions });
  }

  // Values must be unique across a field's whole answer space: an option and a
  // skipOption sharing a value would be indistinguishable on the return trip.
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const [index, option] of group.options.entries()) {
      const key = `${typeof option.value}:${String(option.value)}`;
      const previous = seen.get(key);
      if (previous) {
        out.push(
          error(
            "duplicate_option_value",
            `${location}.${group.what}[${index}] "${field.id}"`,
            `Option value ${JSON.stringify(option.value)} is declared twice on field "${field.id}" (also in ${previous}). Values are how the agent reads the answer back (§4.1) — two options with one value are indistinguishable on the return trip. Give each option its own value; the labels may say whatever you like.`,
          ),
        );
      } else {
        seen.set(key, `${group.what}[${index}]`);
      }
    }
  }
}

function checkMemberIds(field: Field, location: string, out: Diagnostic[]): void {
  const groups: { what: string; ids: string[] }[] = [];
  if (field.type === "matrix") {
    groups.push({ what: "rows", ids: field.rows.map((row) => row.id) });
    groups.push({ what: "cols", ids: field.cols.map((col) => col.id) });
  }
  if (field.type === "allocation") {
    groups.push({
      what: "members",
      ids: field.members.map((member) => member.id),
    });
  }
  if (field.type === "rank") {
    groups.push({ what: "items", ids: field.items.map((item) => item.id) });
  }
  if (field.type === "table") {
    groups.push({ what: "rows", ids: field.rows.map((row) => row.id) });
    groups.push({
      what: "columns",
      ids: field.columns.map((column) => column.id),
    });
  }
  if (field.type === "repeatable") {
    groups.push({ what: "fields", ids: field.fields.map((sub) => sub.id) });
  }

  for (const group of groups) {
    const seen = new Set<string>();
    for (const [index, id] of group.ids.entries()) {
      if (seen.has(id)) {
        out.push(
          error(
            group.what === "rows" && field.type === "table"
              ? "duplicate_row_id"
              : "duplicate_member_id",
            `${location}.${group.what}[${index}] "${field.id}"`,
            `Id "${id}" appears twice in "${field.id}".${group.what}. Ids are addresses (§4.5): two members with one id means every path anchored there is ambiguous — answers and notes would collide. Give each one a distinct id.`,
          ),
        );
      }
      seen.add(id);
    }
  }
}

function checkMatrix(
  field: Extract<Field, { type: "matrix" }>,
  location: string,
  out: Diagnostic[],
): void {
  const selectCell = field.cellType === "single_select" || field.cellType === "multi_select";
  const cellOptions = field.cellOptions ?? [];

  if (selectCell && cellOptions.length === 0) {
    out.push(
      error(
        "matrix_cell_options_required",
        `${location}.cellOptions "${field.id}"`,
        `Matrix "${field.id}" has cellType "${field.cellType}" but declares no "cellOptions". A select cell needs the option set once for the whole grid — that is what makes cycle/paint possible (§5.5). Add "cellOptions": [{ "value": "R", "label": "Read" }, …].`,
      ),
    );
  }
  if (!selectCell && cellOptions.length > 0) {
    out.push(
      error(
        "matrix_cell_options_forbidden",
        `${location}.cellOptions "${field.id}"`,
        `Matrix "${field.id}" declares "cellOptions" but its cellType is "${field.cellType}", which takes no options. Either set cellType to "single_select"/"multi_select", or drop "cellOptions".`,
      ),
    );
  }

  const rowIds = new Set(field.rows.map((row) => row.id));
  const colIds = new Set(field.cols.map((col) => col.id));
  const allowedValues = new Set(
    cellOptions.map((option) => `${typeof option.value}:${String(option.value)}`),
  );

  for (const [index, constraint] of (field.constraints ?? []).entries()) {
    const where = `${location}.constraints[${index}] "${field.id}"`;
    const whereAllowed = `${location}.constraints[${index}].allowed "${field.id}"`;
    if (!rowIds.has(constraint.row)) {
      out.push(
        error(
          "matrix_constraint_unknown_member",
          where,
          `Constraint ${index} of matrix "${field.id}" names row "${constraint.row}", which the matrix does not declare. Matrix row and column ids are agent-declared and fixed for the life of the view (§4.5); declared rows are ${quoteList(field.rows.map((row) => row.id))}.`,
        ),
      );
    }
    if (!colIds.has(constraint.col)) {
      out.push(
        error(
          "matrix_constraint_unknown_member",
          where,
          `Constraint ${index} of matrix "${field.id}" names column "${constraint.col}", which the matrix does not declare. Declared columns are ${quoteList(field.cols.map((col) => col.id))}.`,
        ),
      );
    }
    if (constraint.allowed && selectCell) {
      for (const value of constraint.allowed) {
        if (!allowedValues.has(`${typeof value}:${String(value)}`)) {
          out.push(
            error(
              "matrix_constraint_unknown_value",
              whereAllowed,
              `Constraint ${index} of matrix "${field.id}" allows value ${JSON.stringify(value)}, which is not one of the declared cellOptions (${quoteList(optionValues(field.cellOptions))}). A constraint narrows the shared option set; it cannot introduce a value the grid has no way to render.`,
            ),
          );
        }
      }
    }
    if (!constraint.allowed && constraint.readOnly !== true) {
      out.push(
        error(
          "matrix_constraint_empty",
          where,
          `Constraint ${index} of matrix "${field.id}" says nothing: it narrows no values and does not freeze the cell. Add "allowed": [...] to restrict the cell, or "readOnly": true to freeze it — and a free-text "reason", which is what the renderer shows when a bulk apply skips the cell (§5.5).`,
        ),
      );
    }
  }

  if (field.render === "cycle" && cellOptions.length > MATRIX_CYCLE_OPTION_LIMIT) {
    out.push(
      warning(
        "matrix_cycle_option_count",
        `${location}.render "${field.id}"`,
        `Matrix "${field.id}" asks for "cycle" with ${cellOptions.length} cell options. Cycling degrades past ${MATRIX_CYCLE_OPTION_LIMIT} — a wrong click costs about n/2 more, and the next value stops being predictable (§5.5 decided). Use "paint" (a value palette in the toolbar) at this cardinality, or drop the hint and let the renderer pick.`,
      ),
    );
  }
}

function checkTable(
  field: Extract<Field, { type: "table" }>,
  location: string,
  out: Diagnostic[],
): void {
  for (const [index, column] of field.columns.entries()) {
    if (!(TABLE_COLUMN_TYPES as readonly string[]).includes(column.type)) {
      out.push(
        error(
          "column_type_not_allowed",
          `${location}.columns[${index}] "${column.id}"`,
          `Field type "${(column as Field).type}" is not allowed as a table column. A column is a leaf field definition declared once for every row (§4.2); nesting a container inside a data row is what the columns+data shape exists to avoid. Allowed column types: ${quoteList(TABLE_COLUMN_TYPES)}.`,
        ),
      );
    }
  }
}

function checkRenderHintFit(field: Field, location: string, out: Diagnostic[]): void {
  if (field.type !== "single_select" && field.type !== "multi_select") return;
  const count = field.options.length;
  const hint = field.render;
  if (hint === "segmented" && count > SEGMENTED_OPTION_SOFT_LIMIT) {
    out.push(
      warning(
        "render_hint_option_count",
        `${location}.render "${field.id}"`,
        `Field "${field.id}" asks for "segmented" with ${count} options. Segmented controls are for up to ${SEGMENTED_OPTION_SOFT_LIMIT} short labels (§4.2); beyond that they wrap and stop reading as one control. Use "cards" (up to ${CARDS_OPTION_SOFT_LIMIT}, with descriptions) or "list".`,
      ),
    );
  }
  if (hint === "cards" && count > CARDS_OPTION_SOFT_LIMIT) {
    out.push(
      warning(
        "render_hint_option_count",
        `${location}.render "${field.id}"`,
        `Field "${field.id}" asks for "cards" with ${count} options. Cards are for up to ${CARDS_OPTION_SOFT_LIMIT} options with descriptions (§4.2). Use "list", which is searchable.`,
      ),
    );
  }
  if (count > SEARCHABLE_LIST_THRESHOLD && hint !== undefined && hint !== "list") {
    out.push(
      warning(
        "render_hint_option_count",
        `${location}.render "${field.id}"`,
        `Field "${field.id}" has ${count} options rendered as "${hint}". Above about ${SEARCHABLE_LIST_THRESHOLD} options the searchable "list" is the only one that stays usable (§4.2).`,
      ),
    );
  }
}

function checkComputed(
  form: Form,
  compute: Computed,
  fieldId: string,
  location: string,
  out: Diagnostic[],
): void {
  const targets: { path: string; target: ResolvedTarget }[] = [];
  for (const [index, path] of compute.targets.entries()) {
    const resolved = resolveOrDiagnose(
      form,
      path,
      `${location}.compute.targets[${index}] "${fieldId}"`,
      out,
    );
    if (resolved) targets.push({ path, target: resolved.target });
  }

  if (compute.op === "sum") {
    for (const { path, target } of targets) {
      if (!isNumericTarget(target)) {
        out.push(
          error(
            "computed_target_not_numeric",
            `${location}.compute.targets "${fieldId}"`,
            `Computed field "${fieldId}" sums "${path}", which resolves to ${describeTarget(target)} — there is no number to add. "sum" takes number, slider, allocation or number-celled matrix targets. To count answers instead, use "count_value", "count_answered" or "count_empty" — counting answers rather than summing numbers is usually what a form wants (§4.2).`,
          ),
        );
      }
    }
  }

  if (compute.op === "count_value") {
    const declaredSomewhere = targets.some((entry) => {
      const accepted = acceptedValues(entry.target);
      return accepted === null || accepted.some((value) => value === compute.value);
    });
    if (targets.length > 0 && !declaredSomewhere) {
      out.push(
        error(
          "computed_value_not_declared",
          `${location}.compute.value "${fieldId}"`,
          `Computed field "${fieldId}" counts answers equal to ${JSON.stringify(compute.value)}, but none of its targets declares that value, so the counter can only ever read zero. count_value matches agent-declared option values by equality (§4.3) — use one of ${quoteList(
            targets.flatMap((entry) => acceptedValues(entry.target) ?? []),
          )}, or point the counter at the field that offers it.`,
        ),
      );
    }
  }

  if (compute.op === "count_changed") {
    const prefill = form.prefill ?? {};
    const hasBaseline = Object.entries(prefill).some(([path, entry]) => {
      if (entry.source !== "existing") return false;
      if (!resolvePath(form, path).ok) return false;
      return targets.some((t) => prefillWithinTarget(path, t.path));
    });
    if (!hasBaseline) {
      out.push(
        warning(
          "computed_needs_baseline",
          `${location}.compute "${fieldId}"`,
          `Computed field "${fieldId}" counts changes, but no target carries a prefill with source "existing". "count_changed" is a diff against that baseline (§4.7) — with no baseline it counts every answered field. Add the current values as prefill with source "existing", or use "count_answered".`,
        ),
      );
    }
  }

  if (compute.op === "count_needs_review") {
    const prefill = form.prefill ?? {};
    const hasReviewable = Object.entries(prefill).some(([path, entry]) => {
      if (entry.needsReview !== true) return false;
      if (!resolvePath(form, path).ok) return false;
      return targets.some((t) => prefillWithinTarget(path, t.path));
    });
    if (!hasReviewable) {
      out.push(
        warning(
          "computed_nothing_to_review",
          `${location}.compute "${fieldId}"`,
          `Computed field "${fieldId}" counts values needing review, but no target carries a prefill with "needsReview": true. The counter reads the §4.7 envelope — any touch on the field, even confirming the prefilled value, writes an answer and clears it. Mark the inferred prefills "needsReview": true, or count something else ("count_empty", "count_answered").`,
        ),
      );
    }
  }

  for (const { path, target } of targets) {
    if (isReadOnly(target) && compute.op !== "count_empty") {
      out.push(
        warning(
          "computed_target_read_only",
          `${location}.compute.targets "${fieldId}"`,
          `Computed field "${fieldId}" counts "${path}", which resolves to ${describeTarget(target)}. Info and computed fields hold no answer, so they never contribute to a count.`,
        ),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* rules                                                                      */
/* -------------------------------------------------------------------------- */

const VALUE_REQUIRED_OPS = new Set(["eq", "neq", "gt", "lt"]);
const VALUE_FORBIDDEN_OPS = new Set(["empty", "filled"]);
/** Actions that change what a field holds, and so can feed another `when`. */
const VALUE_AFFECTING_ACTIONS = new Set(["show", "hide", "set_default", "clear"]);
/** Actions that make no sense against a whole section. */
const FIELD_ONLY_ACTIONS = new Set(["filter_options", "set_default", "clear"]);

function checkRule(
  form: Form,
  rule: Rule,
  index: number,
  out: Diagnostic[],
): { whenKey: string | null; thenKeys: string[]; action: string } {
  const whenLoc = `rules[${index}].when.field`;
  const resolvedWhen = resolveOrDiagnose(form, rule.when.field, whenLoc, out);
  const hasValue = "value" in rule.when && rule.when.value !== undefined;

  if (VALUE_REQUIRED_OPS.has(rule.when.op) && !hasValue) {
    out.push(
      error(
        "rule_value_required",
        `rules[${index}].when`,
        `Rule ${index} uses op "${rule.when.op}" with no "value" to compare against. Add "value" — for a select field it is one of the option values you declared, matched by equality (§4.1).`,
      ),
    );
  }
  if (VALUE_FORBIDDEN_OPS.has(rule.when.op) && hasValue) {
    out.push(
      error(
        "rule_value_forbidden",
        `rules[${index}].when.value`,
        `Rule ${index} uses op "${rule.when.op}", which tests only whether the field holds an answer, but also supplies a "value". Drop the value, or switch to "eq"/"neq" if you meant to compare.`,
      ),
    );
  }
  if (rule.when.op === "in" && !Array.isArray(rule.when.value)) {
    out.push(
      error(
        "rule_in_requires_array",
        `rules[${index}].when.value`,
        `Rule ${index} uses op "in", so "value" must be an array of the option values that satisfy it, as in "value": ["aws", "gcp"].`,
      ),
    );
  }
  if (
    (rule.when.op === "gt" || rule.when.op === "lt") &&
    hasValue &&
    typeof rule.when.value !== "number"
  ) {
    out.push(
      error(
        "rule_value_required",
        `rules[${index}].when.value`,
        `Rule ${index} compares with "${rule.when.op}", which orders numbers, but "value" is ${typeof rule.when.value}. Use a number, or "eq"/"in" for option values.`,
      ),
    );
  }

  if (resolvedWhen && VALUE_REQUIRED_OPS.has(rule.when.op) && hasValue) {
    const accepted = acceptedValues(resolvedWhen.target);
    const value = rule.when.value as Value;
    if (accepted && accepted.length > 0 && !accepted.some((candidate) => candidate === value)) {
      out.push(
        error(
          "rule_option_not_declared",
          `rules[${index}].when.value`,
          `Rule ${index} tests "${rule.when.field}" against ${JSON.stringify(value)}, which is not one of the values that field can hold. The condition can never be true. Declared values: ${quoteList(accepted)}.`,
        ),
      );
    }
  }

  const thenKeys: string[] = [];
  const action = rule.then.action;
  for (const [targetIndex, path] of rule.then.targets.entries()) {
    const loc = `rules[${index}].then.targets[${targetIndex}]`;
    const resolved = resolveOrDiagnose(form, path, loc, out);
    if (!resolved) continue;
    const target = resolved.target;
    thenKeys.push(targetKey(target));

    if (target.kind === "row") {
      out.push(
        error(
          "rule_action_target_mismatch",
          loc,
          `Rule ${index} targets "${path}", which addresses a whole row of "${target.container.id}". Rules target fields or sections (§4.6) — name the sub-field or column, as in "${target.container.id}[${target.rowId}].${containerMembers(target.container)[0]?.id ?? "member"}", or use "$self.<member>" to scope the rule to the row being edited.`,
        ),
      );
      continue;
    }
    if (target.kind === "section" && FIELD_ONLY_ACTIONS.has(action)) {
      out.push(
        error(
          "rule_action_target_mismatch",
          loc,
          `Rule ${index} applies "${action}" to section "${target.section.id}". A section holds no value and no options, so only show/hide/enable/disable/require/optional apply to one. Target the fields inside it instead.`,
        ),
      );
      continue;
    }
    if (
      isReadOnly(target) &&
      (action === "set_default" || action === "clear" || action === "require")
    ) {
      out.push(
        error(
          "rule_action_target_mismatch",
          loc,
          `Rule ${index} applies "${action}" to ${describeTarget(target)}, which holds no answer — an info block is read-only markdown and a computed field is derived. Show/hide it instead, or target the field that holds the value.`,
        ),
      );
      continue;
    }

    if (action === "filter_options") {
      const options = optionsOf(target);
      if (options === null) {
        out.push(
          error(
            "rule_target_has_no_options",
            loc,
            `Rule ${index} filters the options of ${describeTarget(target)}, which has none. "filter_options" applies to single_select, multi_select, a matrix cell set, or the presets of a date field. To narrow a number or text field, use a rule that hides it, or restate the field.`,
          ),
        );
      } else if (rule.then.options) {
        const declared = new Set(
          options.map((option) => `${typeof option.value}:${String(option.value)}`),
        );
        for (const value of rule.then.options) {
          if (!declared.has(`${typeof value}:${String(value)}`)) {
            out.push(
              error(
                "rule_option_not_declared",
                `rules[${index}].then.options`,
                `Rule ${index} keeps option ${JSON.stringify(value)} on "${path}", which does not declare it. "filter_options" narrows the declared set — it cannot add values. Declared: ${quoteList(optionValues(options))}.`,
              ),
            );
          }
        }
      }
    }

    if (action === "set_default" && "value" in rule.then) {
      const accepted = acceptedValues(target);
      const value = rule.then.value;
      if (
        accepted &&
        accepted.length > 0 &&
        !(Array.isArray(value)
          ? value.every((entry) => accepted.some((candidate) => candidate === entry))
          : accepted.some((candidate) => candidate === value))
      ) {
        out.push(
          error(
            "rule_default_not_an_option",
            `rules[${index}].then.value`,
            `Rule ${index} defaults "${path}" to ${JSON.stringify(value)}, which is not one of its declared values (${quoteList(accepted)}). set_default writes only into empty fields (§4.6), and it can only write a value the field can hold.`,
          ),
        );
      }
    }
  }

  if (action === "filter_options" && !rule.then.options) {
    out.push(
      error(
        "rule_payload_required",
        `rules[${index}].then`,
        `Rule ${index} uses "filter_options" without saying which options survive. Add "options": [...] listing the option values that remain — that is the half of the mechanic people forget, and without it the rule does nothing (§4.6).`,
      ),
    );
  }
  if (action === "set_default" && !("value" in rule.then)) {
    out.push(
      error(
        "rule_payload_required",
        `rules[${index}].then`,
        `Rule ${index} uses "set_default" without a "value" to write. Add "value" — it is written only into fields that are still empty, so it never clobbers what the user entered (§4.6).`,
      ),
    );
  }
  if (action !== "set_default" && "value" in rule.then && rule.then.value !== undefined) {
    out.push(
      warning(
        "rule_payload_ignored",
        `rules[${index}].then.value`,
        `Rule ${index} carries a "value" but its action is "${action}", which ignores it. Only "set_default" writes a value. Remove it so the rule reads as what it does.`,
      ),
    );
  }
  if (action !== "filter_options" && rule.then.options) {
    out.push(
      warning(
        "rule_payload_ignored",
        `rules[${index}].then.options`,
        `Rule ${index} carries "options" but its action is "${action}", which ignores them. Only "filter_options" narrows an option set.`,
      ),
    );
  }

  return {
    whenKey: resolvedWhen ? targetKey(resolvedWhen.target) : null,
    thenKeys,
    action,
  };
}

/**
 * §4.6 — "rule evaluation re-runs the flat list until the rendered state is
 * stable (small iteration cap; the validator warns on rules that could cycle)".
 *
 * An edge runs from rule A to rule B when A changes what B reads. Only actions
 * that change a value or its rendered-ness qualify: `hide` counts, because a
 * hidden field contributes `empty`.
 */
function checkRuleCycles(
  rules: readonly {
    whenKey: string | null;
    thenKeys: string[];
    action: string;
  }[],
  out: Diagnostic[],
): void {
  const edges = rules.map((rule, index) => {
    if (!VALUE_AFFECTING_ACTIONS.has(rule.action)) return [];
    return rules
      .map((other, otherIndex) => ({ other, otherIndex }))
      .filter(
        ({ other, otherIndex }) =>
          otherIndex !== index && other.whenKey !== null && rule.thenKeys.includes(other.whenKey),
      )
      .map(({ otherIndex }) => otherIndex);
  });

  const state = new Array<0 | 1 | 2>(rules.length).fill(0);
  const stack: number[] = [];
  const reported = new Set<string>();

  const visit = (node: number): void => {
    state[node] = 1;
    stack.push(node);
    for (const next of edges[node] ?? []) {
      if (state[next] === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort((a, b) => a - b).join(",");
        if (!reported.has(key)) {
          reported.add(key);
          out.push(
            warning(
              "rule_cycle",
              `rules[${cycle[0]}]`,
              `Rules ${cycle.join(" → ")} → ${cycle[0]} could cycle: each one changes a field the next one reads. Evaluation re-runs the flat list until the view is stable and stops at an iteration cap (§4.6), so a cycle means the rendered state may depend on where the cap lands. Break the loop — usually one of these rules should read a different field, or be folded into the other.`,
            ),
          );
        }
      } else if (state[next] === 0) {
        visit(next);
      }
    }
    stack.pop();
    state[node] = 2;
  };

  for (let index = 0; index < rules.length; index += 1) {
    if (state[index] === 0) visit(index);
  }
}

/* -------------------------------------------------------------------------- */
/* prefill                                                                    */
/* -------------------------------------------------------------------------- */

function checkPrefill(form: Form, out: Diagnostic[]): void {
  const entries = Object.entries(form.prefill ?? {});
  if (entries.length === 0) {
    out.push(
      warning(
        "no_prefill",
        FORM_ROOT,
        "This form prefills nothing. Reviewing is cheap and authoring is expensive: the agent should infer what it can and render a proposal with provenance on every value. \"If there's nothing to prefill, the form probably shouldn't exist\" (§4.7) — consider asking in chat instead.",
      ),
    );
    return;
  }

  for (const [path, entry] of entries) {
    const location = `prefill["${path}"]`;
    const resolved = resolveOrDiagnose(form, path, location, out);
    if (!resolved) continue;
    const target = resolved.target;

    if (isReadOnly(target)) {
      out.push(
        error(
          "prefill_target_read_only",
          location,
          `Prefill targets ${describeTarget(target)}, which holds no answer — an info block is markdown and a computed field is derived from other answers. Put the text in the info field's "markdown", or prefill the fields the computed field counts.`,
        ),
      );
      continue;
    }
    if (target.kind === "row") {
      out.push(
        error(
          "unresolved_path",
          location,
          `Prefill targets "${path}", a whole row of "${target.container.id}". Prefill one cell at a time, as in "${target.container.id}[${target.rowId}].${containerMembers(target.container)[0]?.id ?? "member"}" — every prefilled value carries its own provenance (§4.7).`,
        ),
      );
      continue;
    }

    const accepted = acceptedValues(target);
    if (accepted && accepted.length > 0) {
      const values = Array.isArray(entry.value) ? entry.value : [entry.value];
      const isMulti =
        target.kind === "field" && target.field.type === "multi_select"
          ? true
          : target.kind === "matrix_cell" && target.field.cellType === "multi_select";
      if (!isMulti && Array.isArray(entry.value)) {
        out.push(
          error(
            "prefill_value_not_an_option",
            location,
            `Prefill for "${path}" is an array, but ${describeTarget(target)} holds one value. Pass the value itself, not a list.`,
          ),
        );
        continue;
      }
      for (const value of values) {
        if (!accepted.some((candidate) => candidate === value)) {
          out.push(
            error(
              "prefill_value_not_an_option",
              location,
              `Prefill for "${path}" is ${JSON.stringify(value)}, which is not one of the values ${describeTarget(target)} can hold: ${quoteList(accepted)}. A prefilled value is rendered as a selected option, so it must be one of the declared values (or one of the field's skipOptions).`,
            ),
          );
        }
      }
    }

    if (entry.confidence && entry.source !== "inferred") {
      out.push(
        warning(
          "malformed",
          location,
          `Prefill for "${path}" declares confidence "${entry.confidence}" with source "${entry.source}". Confidence describes an inference; on a user-stated, default or existing value it renders as noise (§4.7). Drop it, or set source to "inferred".`,
        ),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* section- and form-level smells                                             */
/* -------------------------------------------------------------------------- */

function checkSections(form: Form, out: Diagnostic[]): void {
  for (const [index, section] of form.sections.entries()) {
    const location = sectionLoc(index, section);
    if (section.fields.length === 1) {
      out.push(
        warning(
          "section_single_field",
          location,
          `Section "${section.id}" holds one field. "Never a section with one field" (§4.8) — a section is a unit of the left rail and of section status, and one field does not earn a heading. Merge it into a neighbouring section, or add the fields that belong with it.`,
        ),
      );
    }
    if (section.fields.length > SECTION_FIELD_SOFT_LIMIT) {
      out.push(
        warning(
          "section_over_soft_limit",
          location,
          `Section "${section.id}" holds ${section.fields.length} fields; the soft limit is ${SECTION_FIELD_SOFT_LIMIT} (§4.8). Split it, so the section rail carries real progress instead of one long scroll. A dense list of same-shaped rows is the exception — express that as one "table" field, not ${section.fields.length} fields (§4.2).`,
        ),
      );
    }
  }
}

function checkProseWeight(form: Form, out: Diagnostic[]): void {
  let inputs = 0;
  let prose = 0;
  for (const visit of walkFields(form)) {
    const type = visit.field.type;
    if (type === "info" || type === "computed") continue;
    inputs += 1;
    if (type === "long_text") prose += 1;
  }
  if (prose >= 2 && prose * 2 > inputs) {
    out.push(
      warning(
        "prose_heavy",
        FORM_ROOT,
        `${prose} of ${inputs} input fields are "long_text". A form that is mostly free prose should have been a conversation (§2, §4.2) — the value here is structured input the agent can act on. Keep freeform anchored to a specific item: a per-path note (§4.4) or one correction field revealed by a rule.`,
      ),
    );
  }
}

function checkIdentity(form: Form, out: Diagnostic[]): void {
  const sectionIds = new Map<string, number>();
  for (const [index, section] of form.sections.entries()) {
    const previous = sectionIds.get(section.id);
    if (previous !== undefined) {
      out.push(
        error(
          "duplicate_section_id",
          sectionLoc(index, section),
          `Section id "${section.id}" is already used by sections[${previous}]. Section ids are rule targets (§4.6), so they must be unique.`,
        ),
      );
    } else {
      sectionIds.set(section.id, index);
    }
  }

  const fieldIds = new Map<string, string>();
  for (const visit of walkFields(form)) {
    if (visit.role !== "field") continue;
    const location = `${visit.location} "${visit.field.id}"`;
    const previous = fieldIds.get(visit.field.id);
    if (previous !== undefined) {
      out.push(
        error(
          "duplicate_field_id",
          location,
          `Field id "${visit.field.id}" is already used at ${previous}. A bare path is a field id (§4.5), so top-level field ids must be unique across the whole form — answers, notes and rule targets would otherwise be ambiguous.`,
        ),
      );
    } else {
      fieldIds.set(visit.field.id, location);
    }
    if (sectionIds.has(visit.field.id)) {
      out.push(
        error(
          "id_collision",
          location,
          `Field id "${visit.field.id}" is also a section id (sections[${sectionIds.get(visit.field.id)}]). A bare path would address both. Rename one.`,
        ),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* entry points                                                               */
/* -------------------------------------------------------------------------- */

function result(form: Form | null, diagnostics: Diagnostic[]): ValidationResult {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const ordered = [...errors, ...warnings];
  return {
    ok: errors.length === 0,
    form: errors.length === 0 ? form : null,
    errors,
    warnings,
    diagnostics: ordered,
    text: formatDiagnostics(ordered),
  };
}

/**
 * Validates a form the agent emitted. Input is `unknown` on purpose: the MCP
 * `inputSchema` is loose (§6.3), so this is the only place the contract is
 * actually enforced.
 */
export function validateForm(input: unknown): ValidationResult {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) {
    return result(null, zodIssuesToDiagnostics(parsed.error.issues, input));
  }
  const form = parsed.data;
  const out: Diagnostic[] = [];

  checkIdentity(form, out);

  for (const visit of walkFields(form)) {
    const location = visit.location;
    const field = visit.field;
    checkDuplicateOptionValues(field, location, out);
    checkMemberIds(field, location, out);
    checkRenderHintFit(field, location, out);
    if (field.type === "matrix") checkMatrix(field, location, out);
    if (field.type === "table") checkTable(field, location, out);
    if (field.type === "computed") checkComputed(form, field.compute, field.id, location, out);
    if (
      field.type === "number" &&
      field.min !== undefined &&
      field.max !== undefined &&
      field.max <= field.min
    ) {
      out.push(
        error(
          "malformed",
          `${location}.max "${field.id}"`,
          `Field "${field.id}" declares max ${field.max}, which is not above its min ${field.min}. A range with nothing in it can never be satisfied, and only malformed values gate submit (§6.3).`,
        ),
      );
    }
  }

  const ruleSummaries = (form.rules ?? []).map((rule, index) => checkRule(form, rule, index, out));
  checkRuleCycles(ruleSummaries, out);

  checkPrefill(form, out);
  checkSections(form, out);
  checkProseWeight(form, out);

  return result(form, out);
}

export type AnswersValidationResult = {
  ok: boolean;
  answers: Answers | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  diagnostics: Diagnostic[];
  text: string;
};

/**
 * Validates an answer map (§4.3). With a form, every key is also resolved
 * against it — which is how an ordinal that crept into a persisted answer gets
 * caught rather than silently re-pointing.
 */
export function validateAnswers(input: unknown, form?: Form): AnswersValidationResult {
  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) {
    const diagnostics = zodIssuesToDiagnostics(parsed.error.issues, input, "answers");
    return {
      ok: false,
      answers: null,
      errors: diagnostics,
      warnings: [],
      diagnostics,
      text: formatDiagnostics(diagnostics),
    };
  }

  const out: Diagnostic[] = [];
  for (const path of Object.keys(parsed.data)) {
    const location = `answers["${path}"]`;
    const parsedPath = parsePath(path);
    if (!parsedPath.ok) {
      out.push(error("unresolved_path", location, parsedPath.error.message));
      continue;
    }
    if (form) resolveOrDiagnose(form, path, location, out);
  }

  const errors = out.filter((d) => d.severity === "error");
  const warnings = out.filter((d) => d.severity === "warning");
  const ordered = [...errors, ...warnings];
  return {
    ok: errors.length === 0,
    answers: errors.length === 0 ? parsed.data : null,
    errors,
    warnings,
    diagnostics: ordered,
    text: formatDiagnostics(ordered),
  };
}
