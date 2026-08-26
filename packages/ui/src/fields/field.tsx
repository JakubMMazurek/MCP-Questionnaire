/**
 * Field dispatch. `computed` fields are hoisted into the header as counter pills
 * (§5.1: the counter belongs beside the title, not in the field flow), so they
 * render nothing here.
 *
 * Two layouts, chosen by the field type and nothing else: the DENSE row of the
 * §5.1 mockup (label left, control right) for the controls that fit on one line,
 * and a stacked block for the ones that own a shape — a rank list, an
 * allocation, a repeatable, a slider with its end labels.
 */

import type { ComputedField, Field } from "@mcpq/schema";
import { memo } from "react";
import { Pill, ProvenanceChip } from "../components/primitives";
import { useComputed, usePrefill, useRequired, useVisible } from "../state";
import { AllocationFieldView } from "./allocation";
import { LeafControl } from "./controls";
import { MatrixFieldView } from "./matrix";
import { NoteAffordance } from "./note";
import { RankFieldView } from "./rank";
import { RepeatableFieldView } from "./repeatable";
import { TableFieldView } from "./table";

export function isComputedField(field: Field): field is ComputedField {
  return field.type === "computed";
}

/**
 * The DOM id a section rail or a submit gate jumps to (§6.3 — "malformed values
 * block submit and jump the section rail to the error"). Paths carry `[` and
 * `]`, which are legal in an id but need escaping in a selector, so they are
 * replaced rather than escaped.
 */
export function fieldDomId(path: string): string {
  return `field-${path.replace(/[[\].]/g, "-")}`;
}

/** Scrolls a path's control into view and focuses it. */
export function jumpToPath(path: string): void {
  if (typeof document === "undefined") return;
  const element = document.getElementById(fieldDomId(path));
  if (!element) return;
  element.scrollIntoView({ block: "center" });
  const focusable = element.querySelector<HTMLElement>(
    "input, textarea, select, button, [tabindex]",
  );
  focusable?.focus();
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
    <div className="border-line-soft border-t py-2" id={fieldDomId(field.id)}>
      {field.label ? (
        <div className="text-[length:var(--font-text-sm-size)] font-[var(--font-weight-semibold)]">
          {field.label}
        </div>
      ) : null}
      <Markdown source={field.markdown} />
      {/* §5.4 — a note anchored to plan section three is what makes "the third
          bit is off" resolvable. The block holds no answer; the note does. */}
      <NoteAffordance path={field.id} label={field.label ?? field.id} />
    </div>
  );
});

/**
 * Field types whose control owns its own vertical shape, so the label goes above
 * it rather than beside it.
 */
const STACKED_TYPES = new Set(["rank", "allocation", "repeatable", "slider", "long_text"]);

function isStacked(field: Field): boolean {
  if (STACKED_TYPES.has(field.type)) return true;
  if (field.type === "single_select") return field.render === "cards" || field.render === "radio";
  if (field.type === "multi_select") return field.render === "checkboxes";
  return false;
}

/** The composites: a control that is a whole surface, not a widget on a row. */
const Composite = memo(function Composite({ field, label }: { field: Field; label: string }) {
  switch (field.type) {
    case "rank":
      return <RankFieldView field={field} path={field.id} label={label} />;
    case "allocation":
      return <AllocationFieldView field={field} path={field.id} label={label} />;
    case "repeatable":
      return <RepeatableFieldView field={field} path={field.id} label={label} />;
    default:
      return null;
  }
});

/** A leaf field at section level: label, provenance, control, note. */
const FieldRow = memo(function FieldRow({ field }: { field: Field }) {
  const path = field.id;
  const prefill = usePrefill(path);
  const declaredRequired = "required" in field ? field.required : undefined;
  const required = useRequired(path, declaredRequired);
  const label = ("label" in field && field.label) || field.id;
  const stacked = isStacked(field);
  const composite =
    field.type === "rank" || field.type === "allocation" || field.type === "repeatable";

  const control = composite ? (
    <Composite field={field} label={label} />
  ) : (
    <LeafControl path={path} field={field} label={label} />
  );

  return (
    <div className="ledger-row" id={fieldDomId(path)}>
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
      {stacked ? null : control}
      <NoteAffordance path={path} label={label} />
      {stacked ? <div className="subrow">{control}</div> : null}
    </div>
  );
});

export const FieldView = memo(function FieldView({ field }: { field: Field }) {
  const visible = useVisible(field.id);
  if (!visible || isComputedField(field)) return null;
  if (field.type === "info") return <InfoBlock field={field} />;
  if (field.type === "table") return <TableFieldView field={field} path={field.id} />;
  if (field.type === "matrix") return <MatrixFieldView field={field} path={field.id} />;
  return <FieldRow field={field} />;
});
