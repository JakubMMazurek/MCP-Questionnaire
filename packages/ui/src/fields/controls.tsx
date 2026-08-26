/**
 * Leaf controls. One component per closed field type the renderer branches on
 * (§4.1) — and a plain, honest placeholder for the types that arrive with the
 * later archetypes (§9 build order), because a half-drawn control is worse than
 * a sentence saying so.
 *
 * Each control subscribes to its OWN path and to nothing else.
 */

import type { Field, Value } from "@gather/schema";
import { memo } from "react";
import { type Segment, Segmented } from "../components/primitives";
import { useActions, useDisabled, useEffective, useFilteredOptions } from "../state";

export type LeafControlProps = {
  path: string;
  field: Field;
  /** Accessible name — the row label plus the column label inside a table. */
  label: string;
};

function useSegments(path: string, declared: readonly Segment[], skip: readonly Segment[]) {
  const surviving = useFilteredOptions(path);
  const options = surviving
    ? declared.filter((segment) => surviving.includes(segment.value))
    : declared;
  return [...options, ...skip];
}

const SelectControl = memo(function SelectControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const declared = field.type === "single_select" ? field.options : [];
  const skip: Segment[] =
    "skipOptions" in field && field.skipOptions
      ? field.skipOptions.map((option) => ({ ...option, skip: true }))
      : [];
  const segments = useSegments(path, declared, skip);

  return (
    <Segmented
      segments={segments}
      value={value}
      disabled={disabled}
      label={label}
      onPick={(picked: Value) => actions.setAnswer(path, picked)}
      onClear={() => actions.setEmpty(path)}
    />
  );
});

const BooleanControl = memo(function BooleanControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  if (field.type !== "boolean") return null;
  const segments: Segment[] = [
    { value: true, label: field.trueLabel ?? "Yes" },
    { value: false, label: field.falseLabel ?? "No" },
    ...(field.skipOptions ?? []).map((option) => ({ ...option, skip: true })),
  ];
  return (
    <Segmented
      segments={segments}
      value={value}
      disabled={disabled}
      label={label}
      onPick={(picked) => actions.setAnswer(path, picked)}
      onClear={() => actions.setEmpty(path)}
    />
  );
});

const TextControl = memo(function TextControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const placeholder =
    (field.type === "short_text" || field.type === "long_text") && field.placeholder
      ? field.placeholder
      : "";
  const maxLength =
    (field.type === "short_text" || field.type === "long_text") && field.maxLength
      ? field.maxLength
      : undefined;

  return (
    <input
      className="field-input"
      type="text"
      aria-label={label}
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      placeholder={placeholder}
      {...(maxLength ? { maxLength } : {})}
      onChange={(event) => {
        const next = event.target.value;
        if (next.length === 0) actions.setEmpty(path);
        else actions.setAnswer(path, next);
      }}
    />
  );
});

const NumberControl = memo(function NumberControl({ path, field, label }: LeafControlProps) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const bounds =
    field.type === "number" || field.type === "slider"
      ? { min: field.min, max: field.max, step: field.step }
      : {};

  return (
    <input
      className="field-input"
      type="number"
      aria-label={label}
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
  );
});

function Unsupported({ field }: { field: Field }) {
  return (
    <span className="why">
      “{field.type}” fields arrive with a later archetype (§9) — this build renders the assumption
      ledger.
    </span>
  );
}

/** Dispatch on the closed field-type vocabulary, and nothing else (§4.1). */
export const LeafControl = memo(function LeafControl(props: LeafControlProps) {
  switch (props.field.type) {
    case "single_select":
      return <SelectControl {...props} />;
    case "boolean":
      return <BooleanControl {...props} />;
    case "short_text":
    case "long_text":
      return <TextControl {...props} />;
    case "number":
      return <NumberControl {...props} />;
    default:
      return <Unsupported field={props.field} />;
  }
});
