/**
 * `@gather/schema` — the meta-schema of DESIGN.html §4.
 *
 * One codebase for the Worker and the UI (§8.1): types, the Zod validator with
 * its teaching errors (§6.3), and the path parser/resolver (§4.5).
 */

export {
  countBySeverity,
  type Diagnostic,
  type DiagnosticCode,
  formatDiagnostics,
  type Severity,
} from "./diagnostics.js";
export {
  canonicalPath,
  formatPath,
  hasOrdinalStep,
  type ParsedPath,
  type PathHead,
  type PathParseError,
  type PathParseResult,
  type PathStep,
  parsePath,
  parsePathOrThrow,
} from "./paths.js";
export {
  describeTarget,
  isNumericTarget,
  isRuleTargetable,
  optionsOf,
  type ResolvedTarget,
  type ResolveError,
  type ResolveErrorCode,
  type ResolveOptions,
  type ResolveResult,
  resolvePath,
  type Scope,
} from "./resolve.js";
export { answersSchema, formSchema } from "./shape.js";
export type {
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
  FieldBase,
  Form,
  InfoField,
  LongTextField,
  MatrixField,
  Member,
  MultiSelectField,
  NumberField,
  Option,
  Path,
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
export {
  type AnswersValidationResult,
  type ValidationResult,
  validateAnswers,
  validateForm,
} from "./validate.js";
export type {
  AnswerState,
  ComputedOp,
  ConfidenceLevel,
  DisplayMode,
  FieldType,
  MatrixCellType,
  PrefillSource,
  RuleAction,
  RuleOp,
  SectionInitialState,
  SectionLayout,
  TableColumnType,
} from "./vocab.js";
export {
  ANSWER_STATES,
  COMPUTED_OPS,
  CONFIDENCE_LEVELS,
  DISPLAY_MODES,
  FIELD_TYPES,
  FORM_SCHEMA_VERSION,
  LIMITS,
  MATRIX_CELL_TYPES,
  PREFILL_SOURCES,
  RENDER_HINTS,
  RULE_ACTIONS,
  RULE_OPS,
  renderHintsFor,
  SECTION_FIELD_SOFT_LIMIT,
  SECTION_INITIAL_STATES,
  SECTION_LAYOUTS,
  SUPPORTED_FORM_SCHEMA_VERSIONS,
  TABLE_COLUMN_TYPES,
} from "./vocab.js";
export {
  type ContainerField,
  containerMembers,
  type FieldRole,
  type FieldVisit,
  isContainer,
  walkFields,
} from "./walk.js";
