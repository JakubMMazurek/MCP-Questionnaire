/**
 * Field dispatch. `computed` fields are hoisted into the header as counter pills
 * (§5.1: the counter belongs beside the title, not in the field flow), so they
 * render nothing here.
 */

import type { ComputedField, Field } from "@gather/schema";
import { memo } from "react";
import { Pill, ProvenanceChip } from "../components/primitives";
import { useComputed, usePrefill, useRequired, useVisible } from "../state";
import { LeafControl } from "./controls";
import { NoteAffordance } from "./note";
import { TableFieldView } from "./table";

export function isComputedField(field: Field): field is ComputedField {
  return field.type === "computed";
}

/**
 * Counter tone: ops that count outstanding work read "clear" at zero, ops that
 * count a quantity read neutral. Mirrors the §5.1 and §5.5 mockups, where the
 * pill goes green on "all resolved" and "0 changes".
 */
function toneFor(op: ComputedField["compute"]["op"], value: number) {
  if (op === "count_needs_review" || op === "count_empty") return value > 0 ? "warn" : "clear";
  if (op === "count_changed" || op === "count_value") return value > 0 ? "warn" : "neutral";
  return "neutral";
}

export const CounterPill = memo(function CounterPill({ field }: { field: ComputedField }) {
  const value = useComputed(field.compute);
  return (
    <Pill tone={toneFor(field.compute.op, value)} label={`${value} ${field.label}`}>
      <strong>{value}</strong>
      <span>{field.label}</span>
    </Pill>
  );
});

/** Minimal, safe markdown: paragraphs and `**bold**`. No HTML is ever injected. */
function Markdown({ source }: { source: string }) {
  return (
    <>
      {source.split(/\n{2,}/).map((paragraph, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
        <p key={index} className="m-0 mb-2 text-[length:var(--font-text-sm-size)]">
          {paragraph.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
            part.startsWith("**") && part.endsWith("**") ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional
              <strong key={i}>{part.slice(2, -2)}</strong>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </>
  );
}

const InfoBlock = memo(function InfoBlock({ field }: { field: Extract<Field, { type: "info" }> }) {
  return (
    <div className="border-line-soft border-t py-2">
      {field.label ? (
        <div className="text-[length:var(--font-text-sm-size)] font-[var(--font-weight-semibold)]">
          {field.label}
        </div>
      ) : null}
      <Markdown source={field.markdown} />
    </div>
  );
});

/** A leaf field at section level: label, provenance, control, note. */
const FieldRow = memo(function FieldRow({ field }: { field: Field }) {
  const path = field.id;
  const prefill = usePrefill(path);
  const declaredRequired = "required" in field ? field.required : undefined;
  const required = useRequired(path, declaredRequired);
  const label = ("label" in field && field.label) || field.id;

  return (
    <div className="ledger-row">
      <div className="grow">
        <span className="font-[var(--font-weight-semibold)]">{label}</span>
        {required ? (
          <>
            <span aria-hidden="true" className="text-muted">
              {" *"}
            </span>
            <span className="sr-only">required</span>
          </>
        ) : null}
        {prefill ? (
          <>
            {" "}
            <ProvenanceChip prefill={prefill} />
          </>
        ) : null}
        {"description" in field && field.description ? (
          <span className="why">{field.description}</span>
        ) : null}
      </div>
      <LeafControl path={path} field={field} label={label} />
      <NoteAffordance path={path} label={label} />
    </div>
  );
});

export const FieldView = memo(function FieldView({ field }: { field: Field }) {
  const visible = useVisible(field.id);
  if (!visible || isComputedField(field)) return null;
  if (field.type === "info") return <InfoBlock field={field} />;
  if (field.type === "table") return <TableFieldView field={field} path={field.id} />;
  return <FieldRow field={field} />;
});
