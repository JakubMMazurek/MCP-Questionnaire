/**
 * The Zod layer: accept unknown/loose input, validate strictly (§6.3 — "design
 * the inputSchema loose and validate strict in the app").
 *
 * Structure only. Anything that needs to look at the whole form — path
 * resolution, rule targets, cycles, uniqueness — lives in `validate.ts`.
 *
 * Every schema here is annotated with the hand-written type from `types.ts`, so
 * the two definitions of the meta-schema cannot drift apart silently.
 */

import { z } from "zod";
import { type Diagnostic, type DiagnosticCode, error } from "./diagnostics.js";
import { didYouMean } from "./suggest.js";
import type {
  AllocationField,
  Answer,
  Answers,
  BooleanField,
  CellConstraint,
  Computed,
  ComputedField,
  DateField,
  DateRangeField,
  Field,
  Form,
  InfoField,
  LongTextField,
  MatrixField,
  Member,
  MultiSelectField,
  NumberField,
  Option,
  Prefill,
  PrefillMap,
  RankField,
  RepeatableField,
  Rule,
  Section,
  ShortTextField,
  SingleSelectField,
  SliderField,
  TableColumn,
  TableField,
  TableRow,
  Value,
} from "./types.js";
import {
  ANSWER_STATES,
  COMPUTED_OPS,
  CONFIDENCE_LEVELS,
  DISPLAY_MODES,
  FIELD_TYPES,
  type FieldType,
  LIMITS,
  MATRIX_CELL_TYPES,
  PREFILL_SOURCES,
  quoteList,
  RULE_ACTIONS,
  RULE_OPS,
  renderHintsFor,
  SECTION_INITIAL_STATES,
  SECTION_LAYOUTS,
  SUPPORTED_FORM_SCHEMA_VERSIONS,
} from "./vocab.js";

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ids that sit at the head of a path, so no `.` and no `[`: field ids, section
 * ids, `repeatable` sub-field ids, `table` column ids.
 */
const HEAD_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Ids that only ever appear inside brackets — Salesforce-style names allowed. */
const MEMBER_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const ALL_DIGITS = /^\d+$/;

const headId = (what: string) =>
  z
    .string()
    .min(1, `A ${what} id may not be empty.`)
    .max(LIMITS.id, `A ${what} id may be at most ${LIMITS.id} characters.`)
    .regex(
      HEAD_ID,
      `A ${what} id must start with a letter or "_" and contain only letters, digits, "_" and "-" — it is a path segment (§4.5), so "." and "[" are not allowed.`,
    );

const memberId = (what: string) =>
  z
    .string()
    .min(1, `A ${what} id may not be empty.`)
    .max(LIMITS.id, `A ${what} id may be at most ${LIMITS.id} characters.`)
    .regex(
      MEMBER_ID,
      `A ${what} id must contain only letters, digits, "_", "-" and "." — it is addressed inside brackets, as in "fls[Discount__c]".`,
    );

const freeText = (max: number, what: string) =>
  z
    .string()
    .max(max, `The ${what} may be at most ${max} characters (§4.1: free text, length-capped).`);

const requiredText = (max: number, what: string) =>
  freeText(max, what).min(1, `The ${what} may not be empty — it is what the user reads.`);

/** A path, as a string. Parsed and resolved in `validate.ts`. */
const pathString = z
  .string()
  .min(1, "A path may not be empty.")
  .max(240, "A path may be at most 240 characters.");

const valueSchema: z.ZodType<Value> = z.union([z.string(), z.number(), z.boolean()], {
  error:
    'An option value must be a string, number or boolean — it is matched by equality (§4.1), so objects and arrays are not allowed. Put anything a human reads in "label" or "description".',
});

const optionSchema: z.ZodType<Option> = z.strictObject({
  value: valueSchema,
  label: requiredText(LIMITS.label, "option label"),
  description: freeText(LIMITS.description, "option description").optional(),
});

const memberSchema = (what: string): z.ZodType<Member> =>
  z.strictObject({
    id: memberId(what),
    label: requiredText(LIMITS.label, `${what} label`),
    description: freeText(LIMITS.description, `${what} description`).optional(),
  });

const optionList = (what: string) =>
  z.array(optionSchema).min(1, `${what} must declare at least one option.`);

/** §4.3 — the skip affordance. Ordinary agent-defined options, on any field. */
const skipOptions = z
  .array(optionSchema)
  .min(1, 'If "skipOptions" is present it must declare at least one option — omit it otherwise.')
  .optional();

const fieldBase = {
  id: headId("field"),
  label: requiredText(LIMITS.label, "field label"),
  description: freeText(LIMITS.description, "field description").optional(),
  required: z.boolean().optional(),
  skipOptions,
};

const renderHint = (type: FieldType) => {
  const hints = renderHintsFor(type);
  return z
    .string()
    .superRefine((value, ctx) => {
      if (!hints.includes(value)) {
        ctx.addIssue({
          code: "custom",
          input: value,
          message: `Unknown render hint "${value}" for field type "${type}". Render hints are a closed vocabulary (§4.1); "${type}" accepts ${quoteList(hints)}.${didYouMean(value, hints)}`,
          params: { diagnostic: "unknown_render_hint" },
        });
      }
    })
    .optional();
};

/* -------------------------------------------------------------------------- */
/* computed (§4.1/§4.2 — closed op vocabulary, no expression language)         */
/* -------------------------------------------------------------------------- */

const computedTargets = z
  .array(pathString)
  .min(1, "A computed field must name at least one target path — it counts over answers.");

const computedSchema: z.ZodType<Computed> = z.unknown().transform((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.addIssue({
      code: "custom",
      input: raw,
      message: `A computed field needs a "compute" object, as in { "op": "count_value", "targets": ["verdicts"], "value": "lets_talk" }.`,
    });
    return z.NEVER;
  }
  const op = (raw as Record<string, unknown>).op;
  if (typeof op !== "string" || !(COMPUTED_OPS as readonly string[]).includes(op)) {
    ctx.addIssue({
      code: "custom",
      input: op,
      path: ["op"],
      message: `Unknown computed op ${JSON.stringify(op)}. The op vocabulary is closed (§4.1) — there is no expression language. Use one of ${quoteList(COMPUTED_OPS)}.${didYouMean(op, COMPUTED_OPS)}`,
      params: { diagnostic: "unknown_computed_op" },
    });
    return z.NEVER;
  }
  if (op === "count_value" && !("value" in (raw as Record<string, unknown>))) {
    ctx.addIssue({
      code: "custom",
      input: raw,
      path: ["value"],
      message:
        'A "count_value" computed field must say which value it counts, as in { "op": "count_value", "targets": ["ledger.verdict"], "value": "lets_talk" }. It matches agent-declared option values by equality (§4.3) — there is no meaning attached to them.',
      params: { diagnostic: "computed_value_required" },
    });
    return z.NEVER;
  }
  const variants = {
    count_value: z.strictObject({
      op: z.literal("count_value"),
      targets: computedTargets,
      value: valueSchema,
    }),
    count_empty: z.strictObject({
      op: z.literal("count_empty"),
      targets: computedTargets,
    }),
    count_answered: z.strictObject({
      op: z.literal("count_answered"),
      targets: computedTargets,
    }),
    count_changed: z.strictObject({
      op: z.literal("count_changed"),
      targets: computedTargets,
    }),
    count_needs_review: z.strictObject({
      op: z.literal("count_needs_review"),
      targets: computedTargets,
    }),
    sum: z.strictObject({ op: z.literal("sum"), targets: computedTargets }),
  } as const;
  const parsed = variants[op as keyof typeof variants].safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reissue(ctx, issue);
    return z.NEVER;
  }
  return parsed.data as Computed;
});

/* -------------------------------------------------------------------------- */
/* field variants                                                             */
/* -------------------------------------------------------------------------- */

const singleSelect: z.ZodType<SingleSelectField> = z.strictObject({
  ...fieldBase,
  type: z.literal("single_select"),
  options: optionList("A single_select"),
  render: renderHint("single_select"),
}) as z.ZodType<SingleSelectField>;

const multiSelect: z.ZodType<MultiSelectField> = z.strictObject({
  ...fieldBase,
  type: z.literal("multi_select"),
  options: optionList("A multi_select"),
  render: renderHint("multi_select"),
}) as z.ZodType<MultiSelectField>;

const booleanField: z.ZodType<BooleanField> = z.strictObject({
  ...fieldBase,
  type: z.literal("boolean"),
  render: renderHint("boolean"),
  trueLabel: freeText(LIMITS.buttonLabel, "trueLabel").optional(),
  falseLabel: freeText(LIMITS.buttonLabel, "falseLabel").optional(),
}) as z.ZodType<BooleanField>;

const rankField: z.ZodType<RankField> = z.strictObject({
  ...fieldBase,
  type: z.literal("rank"),
  items: z
    .array(memberSchema("rank item"))
    .min(2, "A rank field needs at least two items — there is nothing to prioritise otherwise."),
}) as z.ZodType<RankField>;

const numberField: z.ZodType<NumberField> = z.strictObject({
  ...fieldBase,
  type: z.literal("number"),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive("A step must be greater than zero.").optional(),
  unit: freeText(LIMITS.placeholder, "unit").optional(),
}) as z.ZodType<NumberField>;

const sliderField: z.ZodType<SliderField> = z
  .strictObject({
    ...fieldBase,
    type: z.literal("slider"),
    min: z.number(),
    max: z.number(),
    step: z.number().positive("A step must be greater than zero.").optional(),
    minLabel: freeText(LIMITS.buttonLabel, "minLabel").optional(),
    maxLabel: freeText(LIMITS.buttonLabel, "maxLabel").optional(),
  })
  .superRefine((field, ctx) => {
    if (field.max <= field.min) {
      ctx.addIssue({
        code: "custom",
        input: field.max,
        path: ["max"],
        message: `A slider's "max" (${field.max}) must be greater than its "min" (${field.min}).`,
      });
    }
  }) as unknown as z.ZodType<SliderField>;

const allocationField: z.ZodType<AllocationField> = z.strictObject({
  ...fieldBase,
  type: z.literal("allocation"),
  total: z.number().positive('An allocation "total" must be greater than zero.'),
  members: z
    .array(memberSchema("allocation member"))
    .min(2, "An allocation needs at least two members — there is nothing to split otherwise."),
  unit: freeText(LIMITS.placeholder, "unit").optional(),
}) as z.ZodType<AllocationField>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (what: string) =>
  z.string().regex(ISO_DATE, `${what} must be an ISO-8601 date, as in "2026-09-30".`);

const dateField: z.ZodType<DateField> = z.strictObject({
  ...fieldBase,
  type: z.literal("date"),
  min: isoDate('A date field\'s "min"').optional(),
  max: isoDate('A date field\'s "max"').optional(),
  presets: z
    .array(optionSchema)
    .min(1, 'If "presets" is present it must declare at least one preset.')
    .optional(),
}) as z.ZodType<DateField>;

const dateRangeField: z.ZodType<DateRangeField> = z.strictObject({
  ...fieldBase,
  type: z.literal("date_range"),
  min: isoDate('A date_range field\'s "min"').optional(),
  max: isoDate('A date_range field\'s "max"').optional(),
  presets: z
    .array(optionSchema)
    .min(1, 'If "presets" is present it must declare at least one preset.')
    .optional(),
}) as z.ZodType<DateRangeField>;

const cellConstraint: z.ZodType<CellConstraint> = z.strictObject({
  row: memberId("matrix row"),
  col: memberId("matrix column"),
  allowed: z
    .array(valueSchema)
    .min(
      1,
      'An empty "allowed" list would leave the cell with no legal value. Use "readOnly": true to freeze it instead.',
    )
    .optional(),
  readOnly: z.boolean().optional(),
  reason: freeText(LIMITS.rationale, "constraint reason").optional(),
});

const matrixField: z.ZodType<MatrixField> = z.strictObject({
  ...fieldBase,
  type: z.literal("matrix"),
  rows: z.array(memberSchema("matrix row")).min(1, "A matrix must declare at least one row."),
  cols: z.array(memberSchema("matrix column")).min(1, "A matrix must declare at least one column."),
  cellType: z.string().superRefine((value, ctx) => {
    if (!(MATRIX_CELL_TYPES as readonly string[]).includes(value)) {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: `Unknown matrix cellType "${value}". A matrix has one cellType for the whole grid (§4.2), drawn from ${quoteList(MATRIX_CELL_TYPES)}.${didYouMean(value, MATRIX_CELL_TYPES)}`,
        params: { diagnostic: "unknown_cell_type" },
      });
    }
  }),
  cellOptions: z
    .array(optionSchema)
    .min(1, '"cellOptions" must declare at least one option when it is present.')
    .optional(),
  render: renderHint("matrix"),
  constraints: z.array(cellConstraint).optional(),
  cellMin: z.number().optional(),
  cellMax: z.number().optional(),
  cellStep: z.number().positive("A step must be greater than zero.").optional(),
}) as z.ZodType<MatrixField>;

const shortTextField: z.ZodType<ShortTextField> = z.strictObject({
  ...fieldBase,
  type: z.literal("short_text"),
  placeholder: freeText(LIMITS.placeholder, "placeholder").optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z
    .string()
    .max(200, "A pattern may be at most 200 characters.")
    .superRefine((source, ctx) => {
      try {
        new RegExp(source);
      } catch {
        ctx.addIssue({
          code: "custom",
          input: source,
          message: `"${source}" is not a valid regular expression, so the renderer could never apply it. A failed pattern is the one thing that blocks submit (§6.3), so it must compile.`,
        });
      }
    })
    .optional(),
}) as z.ZodType<ShortTextField>;

const longTextField: z.ZodType<LongTextField> = z.strictObject({
  ...fieldBase,
  type: z.literal("long_text"),
  placeholder: freeText(LIMITS.placeholder, "placeholder").optional(),
  maxLength: z.number().int().positive().optional(),
}) as z.ZodType<LongTextField>;

const infoField: z.ZodType<InfoField> = z.strictObject({
  type: z.literal("info"),
  id: headId("field"),
  label: freeText(LIMITS.label, "field label").optional(),
  description: freeText(LIMITS.description, "field description").optional(),
  markdown: requiredText(LIMITS.markdown, "markdown body"),
}) as z.ZodType<InfoField>;

const computedField: z.ZodType<ComputedField> = z.strictObject({
  ...fieldBase,
  type: z.literal("computed"),
  compute: computedSchema,
}) as z.ZodType<ComputedField>;

const tableRow: z.ZodType<TableRow> = z
  .strictObject({
    id: memberId("table row"),
    label: freeText(LIMITS.label, "row label").optional(),
    description: freeText(LIMITS.description, "row description").optional(),
  })
  .superRefine((row, ctx) => {
    if (ALL_DIGITS.test(row.id)) {
      ctx.addIssue({
        code: "custom",
        input: row.id,
        path: ["id"],
        message: `Row id "${row.id}" is all digits, which is indistinguishable from an ordinal — and ordinals may never address a user-mutable row (§4.5). Mint an opaque id instead, as in "r_7f3a".`,
      });
    }
  }) as unknown as z.ZodType<TableRow>;

/* -------------------------------------------------------------------------- */
/* the field dispatcher                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The diagnostic code a Zod issue maps to. Nested issues carry theirs forward in
 * `params.diagnostic` so the vocabulary checks keep their precise code after
 * being re-emitted through a dispatcher.
 */
export function diagnosticCodeOf(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") return "unknown_property";
  if (issue.code === "custom") {
    const params = (issue as { params?: Record<string, unknown> }).params;
    const code = params?.diagnostic;
    if (typeof code === "string") return code;
  }
  return "malformed";
}

/** Re-emits a nested issue with its message already rendered. */
function reissue(ctx: z.RefinementCtx, issue: z.core.$ZodIssue): void {
  ctx.addIssue({
    code: "custom",
    input: issue.input,
    path: issue.path as (string | number)[],
    message: renderZodIssue(issue),
    params: { diagnostic: diagnosticCodeOf(issue) },
  });
}

/**
 * Turns a Zod issue into a teaching sentence. Nested issues are rendered here
 * once, at the point they are re-emitted, so `validate.ts` never has to
 * interpret Zod codes a second time.
 */
export function renderZodIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys": {
      const keys = issue.keys.map((k) => `"${k}"`).join(", ");
      return `Unknown ${issue.keys.length === 1 ? "property" : "properties"} ${keys}. The meta-schema is closed: remove it, or move what it said into free text — "label", "description" or a per-path note (§4.1/§4.4).`;
    }
    case "invalid_type":
      return `Expected ${issue.expected}, got ${describeValue(issue.input)}.`;
    case "invalid_value": {
      const values = issue.values.map((v) => JSON.stringify(v)).join(", ");
      return `Expected ${values}, got ${describeValue(issue.input)}.`;
    }
    case "too_small":
      return issue.message;
    case "too_big":
      return issue.message;
    default:
      return issue.message;
  }
}

function describeValue(input: unknown): string {
  if (input === undefined) return "nothing (the property is missing)";
  if (input === null) return "null";
  if (Array.isArray(input)) return `an array (${input.length} items)`;
  if (typeof input === "object") return "an object";
  return `${typeof input} ${JSON.stringify(input)}`;
}

const FIELD_VARIANTS = {
  single_select: singleSelect,
  multi_select: multiSelect,
  boolean: booleanField,
  rank: rankField,
  number: numberField,
  slider: sliderField,
  allocation: allocationField,
  date: dateField,
  date_range: dateRangeField,
  matrix: matrixField,
  short_text: shortTextField,
  long_text: longTextField,
  info: infoField,
  computed: computedField,
  // set below — they recurse through fieldSchema
  repeatable: null as unknown as z.ZodType<RepeatableField>,
  table: null as unknown as z.ZodType<TableField>,
} satisfies Record<FieldType, z.ZodType<Field>>;

/**
 * Validates one field. The `type` discriminator is checked first and on its own,
 * so an unknown type produces one precise error instead of a union dump.
 */
export const fieldSchema: z.ZodType<Field> = z.lazy(() =>
  z.unknown().transform((raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ctx.addIssue({
        code: "custom",
        input: raw,
        message: `Expected a field object with a "type" and an "id", got ${describeValue(raw)}.`,
      });
      return z.NEVER;
    }
    const type = (raw as Record<string, unknown>).type;
    if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) {
      ctx.addIssue({
        code: "custom",
        input: type,
        path: ["type"],
        message: `Unknown field type ${JSON.stringify(type)}. Field types are a closed vocabulary (§4.1) — the renderer can only branch on what it understands. Use one of ${quoteList(FIELD_TYPES)}.${didYouMean(type, FIELD_TYPES)}`,
        params: { diagnostic: "unknown_field_type" },
      });
      return z.NEVER;
    }
    const variant = FIELD_VARIANTS[type as FieldType];
    const parsed = variant.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) reissue(ctx, issue);
      return z.NEVER;
    }
    return parsed.data;
  }),
);

const repeatableField: z.ZodType<RepeatableField> = z.strictObject({
  ...fieldBase,
  type: z.literal("repeatable"),
  fields: z
    .array(fieldSchema)
    .min(1, "A repeatable must declare at least one sub-field — a row needs something in it."),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  addLabel: freeText(LIMITS.buttonLabel, "addLabel").optional(),
}) as z.ZodType<RepeatableField>;

/** A column is a field definition restricted to leaf types (§4.2). */
const tableColumn: z.ZodType<TableColumn> = z.unknown().transform((raw, ctx) => {
  const parsed = fieldSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reissue(ctx, issue);
    return z.NEVER;
  }
  return parsed.data as TableColumn;
});

const tableField: z.ZodType<TableField> = z.strictObject({
  ...fieldBase,
  type: z.literal("table"),
  columns: z
    .array(tableColumn)
    .min(1, "A table must declare at least one column — the column definitions are the schema."),
  rows: z
    .array(tableRow)
    .min(1, "A table must declare at least one row. Never emit a blank form (§4.7)."),
}) as z.ZodType<TableField>;

// Close the recursion.
(FIELD_VARIANTS as Record<string, z.ZodType<Field>>).repeatable = repeatableField;
(FIELD_VARIANTS as Record<string, z.ZodType<Field>>).table = tableField;

/* -------------------------------------------------------------------------- */
/* rules, prefill, sections, envelope                                         */
/* -------------------------------------------------------------------------- */

const ruleSchema: z.ZodType<Rule> = z.strictObject({
  when: z.strictObject({
    field: pathString,
    op: z.string().superRefine((value, ctx) => {
      if (!(RULE_OPS as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: "custom",
          input: value,
          message: `Unknown rule op "${value}". Rule conditions are a closed vocabulary (§4.6): ${quoteList(RULE_OPS)}. There are no boolean trees and no expressions — emit several flat rules instead.${didYouMean(value, RULE_OPS)}`,
          params: { diagnostic: "unknown_rule_op" },
        });
      }
    }),
    value: z.unknown().optional(),
  }),
  then: z.strictObject({
    action: z.string().superRefine((value, ctx) => {
      if (!(RULE_ACTIONS as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: "custom",
          input: value,
          message: `Unknown rule action "${value}". Actions are a closed vocabulary (§4.6): ${quoteList(RULE_ACTIONS)}.${didYouMean(value, RULE_ACTIONS)}`,
          params: { diagnostic: "unknown_rule_action" },
        });
      }
    }),
    targets: z
      .array(pathString)
      .min(1, "A rule must name at least one target — fields or sections (§4.6)."),
    value: z.unknown().optional(),
    options: z.array(valueSchema).min(1).optional(),
  }),
}) as z.ZodType<Rule>;

const prefillSchema: z.ZodType<Prefill> = z
  .strictObject({
    value: z.unknown(),
    source: z.string().superRefine((value, ctx) => {
      if (!(PREFILL_SOURCES as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: "custom",
          input: value,
          message: `Unknown prefill source "${value}". Provenance is a closed vocabulary (§4.7): ${quoteList(PREFILL_SOURCES)} — "inferred" is what earns the amber chip, and "existing" is what gives baseline-diff rendering for free.${didYouMean(value, PREFILL_SOURCES)}`,
          params: { diagnostic: "unknown_prefill_source" },
        });
      }
    }),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
    rationale: freeText(LIMITS.rationale, "rationale").optional(),
    needsReview: z.boolean().optional(),
  })
  .superRefine((prefill, ctx) => {
    if (!("value" in prefill)) {
      ctx.addIssue({
        code: "custom",
        input: prefill,
        path: ["value"],
        message:
          'A prefill entry must carry a "value" — an entry with provenance but no value says nothing. Omit the entry to leave the field empty.',
      });
    }
  }) as unknown as z.ZodType<Prefill>;

const prefillMapSchema: z.ZodType<PrefillMap> = z.record(pathString, prefillSchema);

const sectionSchema: z.ZodType<Section> = z.strictObject({
  id: headId("section"),
  title: requiredText(LIMITS.title, "section title"),
  description: freeText(LIMITS.description, "section description").optional(),
  fields: z
    .array(fieldSchema)
    .min(1, "A section must declare at least one field — an empty section renders as nothing."),
  layout: z.enum(SECTION_LAYOUTS).optional(),
  initially: z.enum(SECTION_INITIAL_STATES).optional(),
}) as z.ZodType<Section>;

export const formSchema: z.ZodType<Form> = z.strictObject({
  version: z.number().superRefine((value, ctx) => {
    if (!(SUPPORTED_FORM_SCHEMA_VERSIONS as readonly number[]).includes(value)) {
      ctx.addIssue({
        code: "custom",
        input: value,
        message: `Unsupported schema version ${JSON.stringify(value)}. This build renders ${quoteList(SUPPORTED_FORM_SCHEMA_VERSIONS)}.`,
        params: { diagnostic: "unsupported_version" },
      });
    }
  }),
  formId: z
    .string()
    .min(1)
    .max(LIMITS.id)
    .optional()
    .describe("Server-minted (§3). Absent on the way in from the agent."),
  title: requiredText(LIMITS.title, "form title"),
  description: freeText(LIMITS.description, "form description").optional(),
  display: z.enum(DISPLAY_MODES).optional(),
  submitLabel: freeText(LIMITS.buttonLabel, "submitLabel").optional(),
  sections: z.array(sectionSchema).min(1, "A form must declare at least one section (§4.8)."),
  rules: z.array(ruleSchema).optional(),
  prefill: prefillMapSchema.optional(),
}) as z.ZodType<Form>;

/* -------------------------------------------------------------------------- */
/* answers (§4.3)                                                             */
/* -------------------------------------------------------------------------- */

const answerSchema: z.ZodType<Answer> = z.unknown().transform((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.addIssue({
      code: "custom",
      input: raw,
      message: `Expected an answer object, got ${describeValue(raw)}. An answer is { "state": "answered", "value": …, "note"?: … } or { "state": "empty" }.`,
    });
    return z.NEVER;
  }
  const record = raw as Record<string, unknown>;
  const state = record.state;
  if (typeof state !== "string" || !(ANSWER_STATES as readonly string[]).includes(state)) {
    ctx.addIssue({
      code: "custom",
      input: state,
      path: ["state"],
      message: `Unknown answer state ${JSON.stringify(state)}. There are exactly two (§4.3): ${quoteList(ANSWER_STATES)} — defer is an ordinary agent-defined option value, not a third state.`,
      params: { diagnostic: "unknown_answer_state" },
    });
    return z.NEVER;
  }
  const note = freeText(LIMITS.note, "note").optional();
  if (state === "answered") {
    if (!("value" in record)) {
      ctx.addIssue({
        code: "custom",
        input: raw,
        path: ["value"],
        message: 'An answer with state "answered" must carry a "value".',
      });
      return z.NEVER;
    }
    const parsed = z
      .strictObject({ state: z.literal("answered"), value: z.unknown(), note })
      .safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) reissue(ctx, issue);
      return z.NEVER;
    }
    return parsed.data as Answer;
  }
  if ("value" in record) {
    ctx.addIssue({
      code: "custom",
      input: record.value,
      path: ["value"],
      message:
        'An answer with state "empty" must not carry a "value" — "not rendered = empty" means an empty answer holds nothing (§4.6). Drop the value, or set the state to "answered".',
    });
    return z.NEVER;
  }
  const parsed = z.strictObject({ state: z.literal("empty"), note }).safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reissue(ctx, issue);
    return z.NEVER;
  }
  return parsed.data as Answer;
});

export const answersSchema: z.ZodType<Answers> = z.record(pathString, answerSchema);

/* -------------------------------------------------------------------------- */
/* issues → diagnostics                                                       */
/* -------------------------------------------------------------------------- */

/** `sections[0].fields[1].options[0].value` — the exact spot, always. */
function pointerOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(form root)";
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc.length === 0 ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

/** The id of the nearest object on the way down — usually the field id. */
function nearestId(raw: unknown, path: readonly PropertyKey[]): string | undefined {
  let node: unknown = raw;
  let id: string | undefined;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) break;
    const candidate = (node as Record<string, unknown>).id;
    if (typeof candidate === "string") id = candidate;
    node = (node as Record<PropertyKey, unknown>)[segment];
  }
  if (typeof node === "object" && node !== null) {
    const candidate = (node as Record<string, unknown>).id;
    if (typeof candidate === "string") id = candidate;
  }
  return id;
}

/**
 * Maps Zod issues onto diagnostics, naming the location precisely and keeping
 * the diagnostic code the vocabulary checks attached.
 */
export function zodIssuesToDiagnostics(
  issues: readonly z.core.$ZodIssue[],
  raw: unknown,
  /**
   * Names the map when the input is path-keyed rather than a form: with
   * `"answers"`, the first segment renders as `answers["ledger[r_1].verdict"]`.
   */
  rootLabel?: string,
): Diagnostic[] {
  return issues.map((issue) => {
    const id = nearestId(raw, issue.path);
    const [head, ...rest] = issue.path;
    const pointer =
      rootLabel && head !== undefined
        ? `${rootLabel}["${String(head)}"]${pointerOf(rest) === "(form root)" ? "" : `.${pointerOf(rest)}`}`
        : pointerOf(issue.path);
    const location = `${pointer}${id ? ` "${id}"` : ""}`;
    return error(diagnosticCodeOf(issue) as DiagnosticCode, location, renderZodIssue(issue));
  });
}
