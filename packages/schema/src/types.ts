/**
 * The meta-schema (DESIGN.html §4), as TypeScript.
 *
 * This file is the readable definition of the contract with the agent; the Zod
 * schemas in `shape.ts` validate against exactly these types (they are declared
 * as `z.ZodType<T>` so the two cannot drift silently).
 *
 * Two conventions run through the whole file:
 *  - Anything the renderer branches on is a closed union imported from `vocab.ts`.
 *  - Anything a human reads is `string`, free text, never parsed (§4.1).
 */

import type {
  AnswerState,
  ComputedOp,
  ConfidenceLevel,
  DisplayMode,
  MatrixCellType,
  PrefillSource,
  RuleAction,
  RuleOp,
  SectionInitialState,
  SectionLayout,
} from "./vocab.js";

/**
 * A path into the form, in the §4.5 grammar (`fls[Discount__c][SalesOps]`).
 * Kept as a branded-free `string` so schemas stay plain JSON; parse it with
 * `parsePath` and check it against a form with `resolvePath`.
 */
export type Path = string;

/**
 * Scalar the renderer matches by equality (§4.1). Agent-declared option values,
 * matrix cell values, `count_value` targets. Never interpreted for meaning.
 */
export type Value = string | number | boolean;

/** An answer choice. `label`/`description` are free text; `value` is matched. */
export type Option = {
  value: Value;
  label: string;
  description?: string;
};

/**
 * A declared, addressable member of a field: matrix row/col, allocation member,
 * rank item. `id` is agent-declared and fixed for the life of the view (§4.5).
 */
export type Member = {
  id: string;
  label: string;
  description?: string;
};

/** Shared by every field type except `info` (which has no answer). */
export type FieldBase = {
  id: string;
  label: string;
  description?: string;
  /**
   * §4.6/§6.3 — `required` MARKS, it never gates. It feeds the section rail,
   * the asterisk and `computed` counters; partial submit stays available.
   */
  required?: boolean;
  /**
   * §4.3 — agent-defined skip affordance on any field ("Let Claude decide",
   * "TBD"). Ordinary options, not a special state; the agent interprets them.
   */
  skipOptions?: Option[];
};

export type SingleSelectField = FieldBase & {
  type: "single_select";
  options: Option[];
  render?: "cards" | "segmented" | "radio" | "list";
};

export type MultiSelectField = FieldBase & {
  type: "multi_select";
  options: Option[];
  render?: "chips" | "checkboxes" | "list";
};

export type BooleanField = FieldBase & {
  type: "boolean";
  render?: "toggle" | "segmented";
  /** Free text on the two states — the agent names its own buttons (§4.1). */
  trueLabel?: string;
  falseLabel?: string;
};

/**
 * §4.2 — drag to prioritise. Position IS the value, so an item can never be
 * addressed by its position (§4.5); `items[].id` is the address.
 */
export type RankField = FieldBase & {
  type: "rank";
  items: Member[];
};

export type NumberField = FieldBase & {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  /** Free text suffix ("days", "£"). */
  unit?: string;
};

/** §5.2 — the tradeoff control. End labels carry the tradeoff, not the numbers. */
export type SliderField = FieldBase & {
  type: "slider";
  min: number;
  max: number;
  step?: number;
  minLabel?: string;
  maxLabel?: string;
};

/** §4.2 — split `total` across `members`; the constraint is on the set. */
export type AllocationField = FieldBase & {
  type: "allocation";
  total: number;
  members: Member[];
  unit?: string;
};

/** §4.2 — named presets ("end of Q3") matter more than the picker. */
export type DateField = FieldBase & {
  type: "date";
  /** ISO-8601 date, inclusive bounds. */
  min?: string;
  max?: string;
  presets?: Option[];
};

export type DateRangeField = FieldBase & {
  type: "date_range";
  min?: string;
  max?: string;
  presets?: Option[];
};

/**
 * §5.5 — a per-cell exception. `row`/`col` are declared member ids. The renderer
 * enforces; it never knows the domain. `reason` is free text shown to the user
 * when a bulk apply skips the cell.
 */
export type CellConstraint = {
  row: string;
  col: string;
  /** Values this cell may hold. Omit to allow the full option set. */
  allowed?: Value[];
  readOnly?: boolean;
  reason?: string;
};

export type MatrixField = FieldBase & {
  type: "matrix";
  rows: Member[];
  cols: Member[];
  cellType: MatrixCellType;
  /** Required for select cell types, forbidden otherwise. */
  cellOptions?: Option[];
  render?: "cycle" | "paint";
  constraints?: CellConstraint[];
  /** Number bounds when `cellType` is `number`. */
  cellMin?: number;
  cellMax?: number;
  cellStep?: number;
};

/**
 * §4.2 — "add another stakeholder". Rows are user-mutable, so rows are addressed
 * by client-minted ids (`r_7f3a`), never ordinals (§4.5).
 */
export type RepeatableField = FieldBase & {
  type: "repeatable";
  fields: Field[];
  min?: number;
  max?: number;
  /** Free text on the add control ("Add another stakeholder"). */
  addLabel?: string;
};

/**
 * §4.2 — a `table` column is an ordinary field definition of a leaf type: type,
 * options, render hint and constraints declared once for the whole column.
 */
export type TableColumn = Extract<
  Field,
  {
    type:
      | "single_select"
      | "multi_select"
      | "boolean"
      | "number"
      | "slider"
      | "date"
      | "date_range"
      | "short_text"
      | "long_text"
      | "info";
  }
>;

/**
 * A data row. `id` is a stable minted id (`r_7f3a`); `label`/`description` carry
 * the row's free text (in the §5.1 ledger: the assumption and the "why").
 * Cell VALUES do not live here — they arrive through the §4.7 prefill envelope,
 * so every one of them carries provenance.
 */
export type TableRow = {
  id: string;
  label?: string;
  description?: string;
};

export type TableField = FieldBase & {
  type: "table";
  columns: TableColumn[];
  rows: TableRow[];
};

export type ShortTextField = FieldBase & {
  type: "short_text";
  placeholder?: string;
  maxLength?: number;
  /** JS regular expression source. A failed match is malformed → gates (§6.3). */
  pattern?: string;
};

/** §4.2 — a smell. If a form is mostly these, it should have been a conversation. */
export type LongTextField = FieldBase & {
  type: "long_text";
  placeholder?: string;
  maxLength?: number;
};

/**
 * §4.2/§5.4 — a markdown block with an id, which is what makes draft review an
 * ordinary form: a note or an approve/revise select anchors to this id.
 */
export type InfoField = {
  type: "info";
  id: string;
  label?: string;
  description?: string;
  markdown: string;
};

/** §4.1/§4.2 — closed op vocabulary, no expression language. */
export type Computed =
  | { op: "count_value"; targets: Path[]; value: Value }
  | { op: "count_empty"; targets: Path[] }
  | { op: "count_answered"; targets: Path[] }
  | { op: "count_changed"; targets: Path[] }
  | { op: "sum"; targets: Path[] };

/** §4.2 — read-only derived value. Counting answers is what makes a form feel alive. */
export type ComputedField = FieldBase & {
  type: "computed";
  compute: Computed;
};

export type Field =
  | SingleSelectField
  | MultiSelectField
  | BooleanField
  | RankField
  | NumberField
  | SliderField
  | AllocationField
  | DateField
  | DateRangeField
  | MatrixField
  | RepeatableField
  | TableField
  | ShortTextField
  | LongTextField
  | InfoField
  | ComputedField;

/** §4.6 — flat list, evaluated in order, re-run until the view is stable. */
export type Rule = {
  when: {
    /** May be `$self`-relative inside a `repeatable`/`table` row. */
    field: Path;
    op: RuleOp;
    /** Required by eq/neq/gt/lt; an array for `in`; forbidden by empty/filled. */
    value?: unknown;
  };
  then: {
    action: RuleAction;
    /** Fields or sections (§4.6). */
    targets: Path[];
    /** Required by `set_default` — written only into `empty` fields (§4.6). */
    value?: unknown;
    /** Required by `filter_options` — the option values that survive. */
    options?: Value[];
  };
};

/** §4.7 — every prefilled value carries provenance. */
export type Prefill = {
  value: unknown;
  source: PrefillSource;
  confidence?: ConfidenceLevel;
  /** Free text: "you mentioned EU customers". */
  rationale?: string;
  needsReview?: boolean;
};

/** Path-keyed, like answers. §4.7. */
export type PrefillMap = Record<Path, Prefill>;

/**
 * §4.3 — flat map, path-keyed, uniform across values and notes. `value` is
 * absent when the state is "empty"; a note may be anchored to either state.
 */
export type Answer =
  | { state: "answered"; value: unknown; note?: string }
  | { state: "empty"; note?: string };

export type Answers = Record<Path, Answer>;

/** §4.8. */
export type Section = {
  id: string;
  title: string;
  description?: string;
  fields: Field[];
  layout?: SectionLayout;
  initially?: SectionInitialState;
};

/**
 * The form envelope. `version` is present from day one (§9); `formId` is minted
 * by the Worker (§3) and is therefore absent on the way in from the agent.
 */
export type Form = {
  version: number;
  /** Server-assigned, crypto-random. The id IS the capability (§3). */
  formId?: string;
  title: string;
  description?: string;
  /** §7.3 — elicitation is an inline card; dense views are fullscreen. */
  display?: DisplayMode;
  /** Free text on the primary action ("Looks right — go"). */
  submitLabel?: string;
  sections: Section[];
  rules?: Rule[];
  prefill?: PrefillMap;
};

export type { AnswerState, ComputedOp, DisplayMode, RuleAction, RuleOp };
