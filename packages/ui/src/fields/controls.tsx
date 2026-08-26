/**
 * Leaf controls. One component per closed field type the renderer branches on
 * (§4.1), and one per closed render hint inside those — nothing here ever reads
 * a label for meaning.
 *
 * Each control subscribes to its OWN path and to nothing else, which is what
 * makes §5.5's "a click re-renders one cell" true of every field type and not
 * only of the ledger's.
 */

import type { Field, Option, Value } from "@mcpq/schema";
import { memo } from "react";
import {
  CheckboxList,
  Chips,
  ComboBox,
  FieldError,
  PresetPills,
  type Segment,
  Segmented,
  Switch,
  Tiles,
} from "../components/primitives";
import { isRange } from "../engine/index.js";
import {
  useActions,
  useDisabled,
  useDisplayMode,
  useEffective,
  useFilteredOptions,
  useMalformed,
} from "../state";

export type LeafControlProps = {
  path: string;
  field: Field;
  /** Accessible name — the row label plus the column label inside a table. */
  label: string;
};

/** A field's `skipOptions` as segments (§4.3 — ordinary agent-defined options). */
function skipsOf(field: Field): Segment[] {
  return "skipOptions" in field && field.skipOptions
    ? field.skipOptions.map((option) => ({ ...option, skip: true }))
    : [];
}

/** Declared options minus whatever `filter_options` removed, plus the skips. */
function useOptions(
  path: string,
  declared: readonly Option[],
  skip: readonly Segment[],
): Segment[] {
  const surviving = useFilteredOptions(path);
  const options = surviving
    ? declared.filter((option) => surviving.includes(option.value))
    : declared;
  return [...options, ...skip];
}

/** The selected set of a `multi_select`, as an array whatever the store holds. */
function asSet(value: unknown): Value[] {
  if (Array.isArray(value)) return value as Value[];
  if (value === undefined) return [];
  return [value as Value];
}

/* -------------------------------------------------------------------------- */
/* single_select — segmented · cards · radio · list                           */
/* -------------------------------------------------------------------------- */

const SelectControl = memo(function SelectControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const mode = useDisplayMode();
  const declared = field.type === "single_select" ? field.options : [];
  const options = useOptions(path, declared, skipsOf(field));
  const render = field.type === "single_select" ? field.render : undefined;

  const pick = (picked: Value) => actions.setAnswer(path, picked);
  const clear = () => actions.setEmpty(path);

  if (render === "list") {
    return (
      <ComboBox
        options={options}
        values={value === undefined ? [] : [value as Value]}
        disabled={disabled}
        label={label}
        // §7.3: the top layer is available in fullscreen and forbidden inline.
        layered={mode === "fullscreen"}
        onToggle={pick}
        onClear={clear}
      />
    );
  }
  if (render === "cards" || render === "radio") {
    return (
      <Tiles
        options={options}
        value={value}
        disabled={disabled}
        label={label}
        variant={render}
        onPick={pick}
        onClear={clear}
      />
    );
  }
  return (
    <Segmented
      segments={options}
      value={value}
      disabled={disabled}
      label={label}
      onPick={pick}
      onClear={clear}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* multi_select — chips · checkboxes · list                                    */
/* -------------------------------------------------------------------------- */

const MultiSelectControl = memo(function MultiSelectControl({
  path,
  field,
  label,
}: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const mode = useDisplayMode();
  const declared = field.type === "multi_select" ? field.options : [];
  const options = useOptions(path, declared, skipsOf(field));
  const render = field.type === "multi_select" ? field.render : undefined;
  const values = asSet(value);

  /**
   * Toggling to the empty set writes `empty`, not `[]`: "answered with nothing
   * selected" and "not answered" are the same thing, and §4.3 has one word for
   * it. A skip option, being an ordinary option, is exclusive — picking "TBD"
   * alongside three real answers would be nonsense the agent has to untangle.
   */
  const toggle = (picked: Value) => {
    const isSkip = options.some((option) => option.skip && option.value === picked);
    if (isSkip) {
      if (values.length === 1 && values[0] === picked) actions.setEmpty(path);
      else actions.setAnswer(path, [picked]);
      return;
    }
    const withoutSkips = values.filter(
      (entry) => !options.some((option) => option.skip && option.value === entry),
    );
    const next = withoutSkips.includes(picked)
      ? withoutSkips.filter((entry) => entry !== picked)
      : [...withoutSkips, picked];
    if (next.length === 0) actions.setEmpty(path);
    else actions.setAnswer(path, next);
  };

  if (render === "list") {
    return (
      <ComboBox
        options={options}
        values={values}
        multi
        disabled={disabled}
        label={label}
        layered={mode === "fullscreen"}
        onToggle={toggle}
        onClear={() => actions.setEmpty(path)}
      />
    );
  }
  if (render === "checkboxes") {
    return (
      <CheckboxList
        options={options}
        values={values}
        disabled={disabled}
        label={label}
        onToggle={toggle}
      />
    );
  }
  return (
    <Chips options={options} values={values} disabled={disabled} label={label} onToggle={toggle} />
  );
});

/* -------------------------------------------------------------------------- */
/* boolean — toggle · segmented                                               */
/* -------------------------------------------------------------------------- */

const BooleanControl = memo(function BooleanControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  if (field.type !== "boolean") return null;
  const trueLabel = field.trueLabel ?? "Yes";
  const falseLabel = field.falseLabel ?? "No";
  const skips = skipsOf(field);

  if (field.render === "toggle") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          value={value}
          trueLabel={trueLabel}
          falseLabel={falseLabel}
          disabled={disabled}
          label={label}
          onPick={(next) => actions.setAnswer(path, next)}
        />
        {skips.length > 0 ? (
          <Segmented
            segments={skips}
            value={value}
            disabled={disabled}
            label={`${label} — skip`}
            onPick={(picked) => actions.setAnswer(path, picked)}
            onClear={() => actions.setEmpty(path)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Segmented
      segments={[{ value: true, label: trueLabel }, { value: false, label: falseLabel }, ...skips]}
      value={value}
      disabled={disabled}
      label={label}
      onPick={(picked) => actions.setAnswer(path, picked)}
      onClear={() => actions.setEmpty(path)}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* text                                                                       */
/* -------------------------------------------------------------------------- */

const TextControl = memo(function TextControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const malformed = useMalformed(path, field);
  const actions = useActions();
  if (field.type !== "short_text" && field.type !== "long_text") return null;
  const text = typeof value === "string" ? value : "";

  const write = (next: string) => {
    if (next.length === 0) actions.setEmpty(path);
    else actions.setAnswer(path, next);
  };

  // `maxLength` is NOT set on the input: the schema says the value is malformed
  // past it, and §6.3 means the user must be able to see the offending value and
  // the sentence explaining it — silently truncating their typing does neither.
  return (
    <div className="stack">
      {field.type === "long_text" ? (
        <textarea
          className="field-input"
          rows={3}
          aria-label={label}
          aria-invalid={malformed !== null}
          value={text}
          disabled={disabled}
          placeholder={field.placeholder ?? ""}
          onChange={(event) => write(event.target.value)}
        />
      ) : (
        <input
          className="field-input"
          type="text"
          aria-label={label}
          aria-invalid={malformed !== null}
          value={text}
          disabled={disabled}
          placeholder={field.placeholder ?? ""}
          onChange={(event) => write(event.target.value)}
        />
      )}
      <FieldError reason={malformed} />
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* number                                                                     */
/* -------------------------------------------------------------------------- */

const NumberControl = memo(function NumberControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const malformed = useMalformed(path, field);
  const actions = useActions();
  const bounds =
    field.type === "number" || field.type === "slider"
      ? { min: field.min, max: field.max, step: field.step }
      : {};
  const unit = field.type === "number" ? field.unit : undefined;
  const skips = skipsOf(field);

  return (
    <div className="stack">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="field-input number-input"
          type="number"
          aria-label={label}
          aria-invalid={malformed !== null}
          value={typeof value === "number" ? String(value) : ""}
          disabled={disabled}
          {...(bounds.min !== undefined ? { min: bounds.min } : {})}
          {...(bounds.max !== undefined ? { max: bounds.max } : {})}
          {...(bounds.step !== undefined ? { step: bounds.step } : {})}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw.length === 0) actions.setEmpty(path);
            else actions.setAnswer(path, Number(raw));
          }}
        />
        {unit ? <span className="unit">{unit}</span> : null}
        {skips.length > 0 ? (
          <Segmented
            segments={skips}
            value={value}
            disabled={disabled}
            label={`${label} — skip`}
            onPick={(picked) => actions.setAnswer(path, picked)}
            onClear={() => actions.setEmpty(path)}
          />
        ) : null}
      </div>
      <FieldError reason={malformed} />
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* slider — the §5.2 tradeoff control                                         */
/* -------------------------------------------------------------------------- */

const SliderControl = memo(function SliderControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  if (field.type !== "slider") return null;
  // End labels carry the tradeoff; the number is incidental (§5.2).
  const current = typeof value === "number" ? value : Math.round((field.min + field.max) / 2);

  return (
    <div className="slider-line">
      {field.minLabel ? <span className="slider-end">{field.minLabel}</span> : null}
      <input
        className="slider"
        type="range"
        aria-label={label}
        min={field.min}
        max={field.max}
        {...(field.step !== undefined ? { step: field.step } : {})}
        value={current}
        disabled={disabled}
        data-empty={value === undefined}
        onChange={(event) => actions.setAnswer(path, Number(event.target.value))}
      />
      {field.maxLabel ? <span className="slider-end">{field.maxLabel}</span> : null}
      <span className="unit" aria-hidden="true">
        {value === undefined ? "—" : current}
      </span>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* date · date_range                                                          */
/* -------------------------------------------------------------------------- */

/** True when the value came from a preset or a skip rather than the picker. */
function isDeclared(options: readonly Segment[], value: unknown): boolean {
  return options.some((option) => option.value === value);
}

const DateControl = memo(function DateControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  if (field.type !== "date") return null;
  const presets = field.presets ?? [];
  const skips = skipsOf(field);
  const options = [...presets, ...skips];
  // A skip value is an agent-declared scalar, not a date, so it must never be
  // fed to the picker (§4.3).
  const asDate = typeof value === "string" && !isDeclared(skips, value) ? value : "";

  return (
    <div className="stack">
      {options.length > 0 ? (
        <PresetPills
          options={options}
          value={value}
          disabled={disabled}
          label={`${label} — presets`}
          onPick={(picked) => actions.setAnswer(path, picked)}
          onClear={() => actions.setEmpty(path)}
        />
      ) : null}
      <input
        className="field-input date-input"
        type="date"
        aria-label={label}
        value={asDate}
        disabled={disabled}
        {...(field.min ? { min: field.min } : {})}
        {...(field.max ? { max: field.max } : {})}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw.length === 0) actions.setEmpty(path);
          else actions.setAnswer(path, raw);
        }}
      />
    </div>
  );
});

/**
 * `date_range`. The answer is `{ start, end }` — DECIDED at step 5, because the
 * schema declares no shape for it and two ISO strings under stable keys is the
 * only shape a rule's `gt`/`lt` and the agent can both read. A preset or skip
 * option still writes its own declared scalar, which the agent authored and
 * interprets itself.
 */
const DateRangeControl = memo(function DateRangeControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const malformed = useMalformed(path, field);
  const actions = useActions();
  if (field.type !== "date_range") return null;
  const presets = field.presets ?? [];
  const skips = skipsOf(field);
  const options = [...presets, ...skips];
  const range = isRange(value) ? value : {};

  const write = (patch: { start?: string; end?: string }) => {
    const next = { ...range, ...patch };
    const start = next.start && next.start.length > 0 ? next.start : undefined;
    const end = next.end && next.end.length > 0 ? next.end : undefined;
    if (!start && !end) actions.setEmpty(path);
    else actions.setAnswer(path, { ...(start ? { start } : {}), ...(end ? { end } : {}) });
  };

  return (
    <div className="stack">
      {options.length > 0 ? (
        <PresetPills
          options={options}
          value={value}
          disabled={disabled}
          label={`${label} — presets`}
          onPick={(picked) => actions.setAnswer(path, picked)}
          onClear={() => actions.setEmpty(path)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="field-input date-input"
          type="date"
          aria-label={`${label} — start`}
          aria-invalid={malformed !== null}
          value={range.start ?? ""}
          disabled={disabled}
          {...(field.min ? { min: field.min } : {})}
          {...(field.max ? { max: field.max } : {})}
          onChange={(event) => write({ start: event.target.value })}
        />
        <span className="unit" aria-hidden="true">
          →
        </span>
        <input
          className="field-input date-input"
          type="date"
          aria-label={`${label} — end`}
          aria-invalid={malformed !== null}
          value={range.end ?? ""}
          disabled={disabled}
          {...(range.start ? { min: range.start } : field.min ? { min: field.min } : {})}
          {...(field.max ? { max: field.max } : {})}
          onChange={(event) => write({ end: event.target.value })}
        />
      </div>
      <FieldError reason={malformed} />
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The types that are NOT leaf controls: they own their own layout and are
 * dispatched a level up, in `field.tsx`.
 */
export const COMPOSITE_TYPES = new Set(["rank", "allocation", "repeatable", "matrix", "table"]);

function Unsupported({ field }: { field: Field }) {
  return <span className="why">“{field.type}” has no control — this is a renderer bug.</span>;
}

/** Dispatch on the closed field-type vocabulary, and nothing else (§4.1). */
export const LeafControl = memo(function LeafControl(props: LeafControlProps) {
  switch (props.field.type) {
    case "single_select":
      return <SelectControl {...props} />;
    case "multi_select":
      return <MultiSelectControl {...props} />;
    case "boolean":
      return <BooleanControl {...props} />;
    case "short_text":
    case "long_text":
      return <TextControl {...props} />;
    case "number":
      return <NumberControl {...props} />;
    case "slider":
      return <SliderControl {...props} />;
    case "date":
      return <DateControl {...props} />;
    case "date_range":
      return <DateRangeControl {...props} />;
    default:
      return <Unsupported field={props.field} />;
  }
});
