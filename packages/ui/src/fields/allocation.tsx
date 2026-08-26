/**
 * `allocation` — split `total` across members (§4.2).
 *
 * Two decisions, both DECIDED at step 5 and both consequences of "the constraint
 * is on the SET, not the field":
 *
 *  - The answer lives at one path PER MEMBER (`effort[design]`), not as one
 *    object at the field path. That is what the engine's leaf enumeration
 *    already says an allocation is, and it is what lets `sum` add the field,
 *    `count_answered` count members, and a note anchor to one of them. The agent
 *    reads it back as a member-id → number map, spread across paths the way
 *    every other cell is (§4.3).
 *  - Over-allocating is MALFORMED and blocks submit — the agent's own `total`
 *    says that split cannot exist. Under-allocating is fine and submits: partial
 *    submit is the norm (§5.6) and the remainder is visible in the payload, so
 *    the agent can decide what to do with it.
 */

import type { AllocationField } from "@gather/schema";
import { memo } from "react";
import { FieldError, Pill } from "../components/primitives";
import { joinPath } from "../engine/index.js";
import { useActions, useDisabled, useEffective, useEngine, useFieldMalformed } from "../state";

/** The sum of the members' effective values — the number the indicator reads. */
function useAllocated(field: AllocationField, path: string): number {
  return useEngine((state) => {
    let total = 0;
    for (const member of field.members) {
      const entry = state.answers[joinPath(path, member.id)];
      if (entry?.state === "answered") {
        if (typeof entry.value === "number") total += entry.value;
        continue;
      }
      if (entry) continue;
      const overlay = state.effects.defaults.get(joinPath(path, member.id));
      const prefilled = state.prefill[joinPath(path, member.id)]?.value;
      const fallback = overlay !== undefined ? overlay : prefilled;
      if (typeof fallback === "number") total += fallback;
    }
    return total;
  });
}

const MemberRow = memo(function MemberRow({
  path,
  memberLabel,
  description,
  unit,
  disabled,
}: {
  path: string;
  memberLabel: string;
  description?: string;
  unit?: string;
  disabled: boolean;
}) {
  const value = useEffective(path);
  const ownDisabled = useDisabled(path);
  const actions = useActions();

  return (
    <div className="alloc-row">
      <span className="grow">
        <span className="tile-label">{memberLabel}</span>
        {description ? <span className="tile-description">{description}</span> : null}
      </span>
      <input
        className="field-input number-input"
        type="number"
        min={0}
        aria-label={memberLabel}
        value={typeof value === "number" ? String(value) : ""}
        disabled={disabled || ownDisabled}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw.length === 0) actions.setEmpty(path);
          else actions.setAnswer(path, Number(raw));
        }}
      />
      {unit ? <span className="unit">{unit}</span> : null}
    </div>
  );
});

export const AllocationFieldView = memo(function AllocationFieldView({
  field,
  path,
  label,
}: {
  field: AllocationField;
  path: string;
  label: string;
}) {
  const allocated = useAllocated(field, path);
  const disabled = useDisabled(path);
  const malformed = useFieldMalformed(path);
  const remaining = field.total - allocated;
  const unit = field.unit ? ` ${field.unit}` : "";

  return (
    <section className="stack" aria-label={label}>
      <div className="flex items-center justify-between gap-3">
        <Pill
          tone={remaining < 0 ? "warn" : remaining === 0 ? "clear" : "neutral"}
          label={
            remaining < 0
              ? `${-remaining}${unit} over the ${field.total}${unit} available`
              : `${remaining}${unit} of ${field.total}${unit} left to allocate`
          }
        >
          <strong>
            {remaining < 0 ? `+${-remaining}` : remaining}
            {field.unit ?? ""}
          </strong>
          <span>{remaining < 0 ? "over" : "left"}</span>
        </Pill>
      </div>
      {field.members.map((member) => (
        <MemberRow
          key={member.id}
          path={joinPath(path, member.id)}
          memberLabel={member.label}
          {...(member.description ? { description: member.description } : {})}
          {...(field.unit ? { unit: field.unit } : {})}
          disabled={disabled}
        />
      ))}
      <FieldError reason={malformed} label={label} />
    </section>
  );
});
