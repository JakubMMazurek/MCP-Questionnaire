/**
 * Diagnostics (DESIGN.html §6.3, CLAUDE.md "Validator error messages are a
 * product surface").
 *
 * Every diagnostic must (a) name the exact location — field id, rule index,
 * path — (b) state what is wrong, and (c) say what to do instead. "Invalid
 * input" is a bug. The text rendering is what goes back to the agent in the
 * tool result, so it is part of the contract, not debug output.
 */

export type Severity = "error" | "warning";

/** Stable machine codes. Errors reject the form; warnings do not. */
export type DiagnosticCode =
  // shape (Zod)
  | "malformed"
  | "unknown_property"
  | "unsupported_version"
  // vocabularies
  | "unknown_field_type"
  | "unknown_render_hint"
  | "unknown_rule_op"
  | "unknown_rule_action"
  | "unknown_computed_op"
  | "unknown_cell_type"
  | "unknown_prefill_source"
  | "unknown_answer_state"
  | "column_type_not_allowed"
  // identity
  | "duplicate_section_id"
  | "duplicate_field_id"
  | "id_collision"
  | "duplicate_member_id"
  | "duplicate_option_value"
  | "duplicate_row_id"
  // paths
  | "unresolved_path"
  | "ordinal_path"
  // rules
  | "rule_value_required"
  | "rule_value_forbidden"
  | "rule_in_requires_array"
  | "rule_payload_required"
  | "rule_target_has_no_options"
  | "rule_option_not_declared"
  | "rule_default_not_an_option"
  | "rule_payload_ignored"
  | "rule_action_target_mismatch"
  | "rule_cycle"
  // computed
  | "computed_value_required"
  | "computed_value_not_declared"
  | "computed_target_not_numeric"
  | "computed_target_read_only"
  | "computed_needs_baseline"
  | "computed_nothing_to_review"
  // prefill
  | "prefill_target_read_only"
  | "prefill_value_not_an_option"
  // matrix
  | "matrix_cell_options_required"
  | "matrix_cell_options_forbidden"
  | "matrix_constraint_unknown_member"
  | "matrix_constraint_unknown_value"
  | "matrix_constraint_empty"
  // sections & smells
  | "section_single_field"
  | "section_over_soft_limit"
  | "no_prefill"
  | "prose_heavy"
  | "render_hint_option_count"
  | "matrix_cycle_option_count"
  | "self_scope_ambiguous";

export type Diagnostic = {
  severity: Severity;
  /** Machine-readable; the message is the product surface. */
  code: DiagnosticCode;
  /** Exact location: `sections[0].fields[1] "env"`, `rules[3].when.field`. */
  location: string;
  /** What is wrong, and what to write instead. Complete sentences. */
  message: string;
};

export function error(code: DiagnosticCode, location: string, message: string): Diagnostic {
  return { severity: "error", code, location, message };
}

export function warning(code: DiagnosticCode, location: string, message: string): Diagnostic {
  return { severity: "warning", code, location, message };
}

const WRAP_WIDTH = 92;

function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current.length === 0) {
        current = word;
      } else if (`${current} ${word}`.length + indent.length <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(indent + current);
        current = word;
      }
    }
    lines.push(indent + current);
  }
  return lines;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): {
  errors: number;
  warnings: number;
} {
  return {
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };
}

/**
 * Renders diagnostics as the text that goes back to the agent. Errors first,
 * in the order they were found; the headline says whether the form rendered.
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const { errors, warnings } = countBySeverity(diagnostics);
  const ordered = [
    ...diagnostics.filter((d) => d.severity === "error"),
    ...diagnostics.filter((d) => d.severity === "warning"),
  ];

  const headline =
    errors > 0
      ? `Form rejected — ${plural(errors, "error")}${warnings > 0 ? `, ${plural(warnings, "warning")}` : ""}. Nothing was rendered; fix the errors and call again.`
      : warnings > 0
        ? `Form accepted — ${plural(warnings, "warning")}. It renders as-is; the warnings are smells worth a second look.`
        : "Form accepted — no problems found.";

  if (ordered.length === 0) return headline;

  const blocks = ordered.map((d) => {
    const head = `${d.severity === "error" ? "ERROR  " : "WARNING"} ${d.code} · ${d.location}`;
    return [head, ...wrap(d.message, WRAP_WIDTH, "  ")].join("\n");
  });

  return `${headline}\n\n${blocks.join("\n\n")}`;
}
