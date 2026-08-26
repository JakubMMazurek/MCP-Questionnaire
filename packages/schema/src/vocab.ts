/**
 * Closed vocabularies (DESIGN.html §4.1).
 *
 * The renderer and the validator branch ONLY on the members of these lists.
 * Everything a human reads — labels, titles, descriptions, option display text,
 * rationale, notes, placeholders — is free text and is never parsed for meaning.
 *
 * Adding a member here is a deliberate widening of the contract with the agent.
 */

/** Envelope version. Bumped when a change is not backwards compatible. */
export const FORM_SCHEMA_VERSION = 1;

/** Every version this build can render. */
export const SUPPORTED_FORM_SCHEMA_VERSIONS = [1] as const;

/** §4.2 field types. */
export const FIELD_TYPES = [
  "single_select",
  "multi_select",
  "boolean",
  "rank",
  "number",
  "slider",
  "allocation",
  "date",
  "date_range",
  "matrix",
  "repeatable",
  "table",
  "short_text",
  "long_text",
  "info",
  "computed",
] as const;

/**
 * §4.2 render hints, per field type. A type absent from this map takes no
 * render hint at all — the renderer has exactly one way to draw it.
 */
export const RENDER_HINTS = {
  single_select: ["cards", "segmented", "radio", "list"],
  multi_select: ["chips", "checkboxes", "list"],
  boolean: ["toggle", "segmented"],
  /** §5.5 — cell interaction mode. Picked from the option count unless stated. */
  matrix: ["cycle", "paint"],
} as const satisfies Partial<Record<(typeof FIELD_TYPES)[number], readonly string[]>>;

/** §5.5 — one `cellType` for the whole grid. */
export const MATRIX_CELL_TYPES = [
  "single_select",
  "multi_select",
  "boolean",
  "number",
  "short_text",
] as const;

/**
 * §4.2 `table` — columns are ordinary field definitions restricted to leaf
 * types: a column declares type, options, render hint and constraints once.
 * Containers (`table`, `matrix`, `repeatable`), set-level fields (`allocation`),
 * `rank` and `computed` are not columns.
 */
export const TABLE_COLUMN_TYPES = [
  "single_select",
  "multi_select",
  "boolean",
  "number",
  "slider",
  "date",
  "date_range",
  "short_text",
  "long_text",
  "info",
] as const;

/** §4.6 rule conditions. */
export const RULE_OPS = ["eq", "neq", "in", "gt", "lt", "empty", "filled"] as const;

/** §4.6 rule actions. */
export const RULE_ACTIONS = [
  "show",
  "hide",
  "enable",
  "disable",
  "require",
  "optional",
  "filter_options",
  "set_default",
  "clear",
] as const;

/**
 * §4.1/§4.2 — the closed `computed` op vocabulary. There is no expression
 * language: an implicit one is where model-generated schemas fall apart (§9).
 *
 * - `count_value`    count answers over `targets` whose value equals `value`
 * - `count_empty`    count targets whose answer state is "empty"
 * - `count_answered` count targets whose answer state is "answered"
 * - `count_changed`  count targets whose answer differs from their
 *                    `source: "existing"` prefill (the §4.7 baseline)
 * - `count_needs_review` count targets whose prefill carries `needsReview: true`
 *                    and which hold no answer yet — any touch, even confirming
 *                    the prefilled value, writes an answer and clears it. The
 *                    §4.7 "N inferred values need review" header counter; on a
 *                    fully-prefilled form `count_empty` reads 0, this doesn't
 * - `sum`            add the numeric answers over `targets`
 */
export const COMPUTED_OPS = [
  "count_value",
  "count_empty",
  "count_answered",
  "count_changed",
  "count_needs_review",
  "sum",
] as const;

/** §4.7 provenance. */
export const PREFILL_SOURCES = ["user", "inferred", "default", "existing"] as const;

/** §4.7 confidence. Only `inferred` values realistically carry one. */
export const CONFIDENCE_LEVELS = ["high", "low"] as const;

/** §4.3 answer states. There is no third state — defer is an ordinary option. */
export const ANSWER_STATES = ["answered", "empty"] as const;

/** §4.8 section layout. */
export const SECTION_LAYOUTS = ["stack", "two_col"] as const;

/** §4.8 initial disclosure state. */
export const SECTION_INITIAL_STATES = ["expanded", "collapsed"] as const;

/** §7.3 display modes this app uses (`pip` is out of scope). */
export const DISPLAY_MODES = ["inline", "fullscreen"] as const;

/** §4.8 soft limit — more fields than this in one section is a warning. */
export const SECTION_FIELD_SOFT_LIMIT = 7;

/** §4.2 render-hint soft limits, from the "Notes" column of the field table. */
export const SEGMENTED_OPTION_SOFT_LIMIT = 4;
export const CARDS_OPTION_SOFT_LIMIT = 6;
export const SEARCHABLE_LIST_THRESHOLD = 15;

/** §5.5 — cycling stops being predictable past this many cell options. */
export const MATRIX_CYCLE_OPTION_LIMIT = 4;

/** Free-text length caps. §4.1: free text is unvalidated "beyond length limits". */
export const LIMITS = {
  id: 80,
  title: 200,
  label: 400,
  description: 2000,
  rationale: 600,
  markdown: 20_000,
  note: 4000,
  placeholder: 200,
  buttonLabel: 80,
} as const;

export type FieldType = (typeof FIELD_TYPES)[number];
export type MatrixCellType = (typeof MATRIX_CELL_TYPES)[number];
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];
export type RuleOp = (typeof RULE_OPS)[number];
export type RuleAction = (typeof RULE_ACTIONS)[number];
export type ComputedOp = (typeof COMPUTED_OPS)[number];
export type PrefillSource = (typeof PREFILL_SOURCES)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export type AnswerState = (typeof ANSWER_STATES)[number];
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];
export type SectionInitialState = (typeof SECTION_INITIAL_STATES)[number];
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** Render hints legal for `type`, or `[]` when the type takes none. */
export function renderHintsFor(type: FieldType): readonly string[] {
  return type in RENDER_HINTS ? RENDER_HINTS[type as keyof typeof RENDER_HINTS] : [];
}

/** Formats a closed vocabulary for an error message: `"a", "b", "c"`. */
export function quoteList(values: readonly (string | number | boolean)[]): string {
  return values.map((v) => `"${String(v)}"`).join(", ");
}
