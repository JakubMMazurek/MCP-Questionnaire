/**
 * The only thing that may block submit (§6.3).
 *
 * `require` marks, it never gates — partial submit is always available (§5.6).
 * A MALFORMED value is different: a short_text that fails its declared
 * `pattern`, a number outside its declared bounds, a date range that ends
 * before it starts, an `allocation` that hands out more than there is to give.
 * Sending those back would hand the agent data its own schema says is
 * impossible, so submit waits until the user fixes them. Hidden leaves are
 * exempt: they submit `empty`.
 */

import type { Field } from "@gather/schema";
import { isVisible } from "./computed.js";
import { effectiveValue, type ValueContext } from "./effective.js";
import type { Effects } from "./evaluate.js";
import type { Leaf } from "./leaves.js";

export type Malformed = { path: string; label: string; reason: string };

/**
 * Whether ONE value is impossible against its own field definition. Exported
 * because the control that owns the value renders the same sentence in place —
 * a gate the user cannot see is a dead end (§6.3).
 *
 * Field-level only. Set-level constraints (`allocation`) are checked in
 * `malformedValues`, which is the only place that can see a whole set.
 */
export function malformedReason(field: Field, value: unknown): string | null {
  if (field.type === "short_text" || field.type === "long_text") {
    if (typeof value !== "string") return null;
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return `longer than the ${field.maxLength} characters this field accepts`;
    }
    if (field.type === "short_text" && field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return "does not match the expected format";
      } catch {
        // An unparsable pattern is the agent's bug, not the user's: never block.
        return null;
      }
    }
    return null;
  }
  if (field.type === "number" || field.type === "slider") {
    if (typeof value !== "number" || Number.isNaN(value)) return "is not a number";
    if (field.min !== undefined && value < field.min) return `is below the minimum of ${field.min}`;
    if (field.max !== undefined && value > field.max) return `is above the maximum of ${field.max}`;
    return null;
  }
  if (field.type === "date" || field.type === "date_range") {
    // A preset or a skip option is an agent-declared scalar, not a date — the
    // agent authored it and reads it back itself (§4.3), so it is never
    // malformed. Only the range the two inputs produce is checked.
    if (field.type === "date_range" && isRange(value)) {
      if (value.start && value.end && value.start > value.end) {
        return "ends before it starts";
      }
    }
    return null;
  }
  return null;
}

export type DateRange = { start?: string; end?: string };

/** The `date_range` answer shape: `{ start, end }`, both ISO-8601 dates. */
export function isRange(value: unknown): value is DateRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  const ok = (entry: unknown) => entry === undefined || typeof entry === "string";
  return ok(range.start) && ok(range.end);
}

/**
 * §4.2 — "the constraint is on the SET, not the field". DECIDED for step 5:
 * over-allocating is malformed and blocks (the agent's own `total` says that
 * split cannot exist), while UNDER-allocating is fine — a partial split submits
 * and the agent sees the remainder, exactly as partial submit works everywhere
 * else (§5.6).
 */
function allocationOverspend(
  field: Extract<Field, { type: "allocation" }>,
  members: readonly Leaf[],
  values: ValueContext,
): string | null {
  let total = 0;
  let touched = false;
  for (const leaf of members) {
    const effective = effectiveValue(values, leaf.path);
    if (!effective.present || typeof effective.value !== "number") continue;
    touched = true;
    total += effective.value;
  }
  if (!touched || total <= field.total) return null;
  const unit = field.unit ? ` ${field.unit}` : "";
  return `allocates ${total}${unit} of ${field.total}${unit} — ${total - field.total}${unit} too much`;
}

/** Every visible leaf whose value the form's own schema rejects. */
export function malformedValues(
  leaves: readonly Leaf[],
  values: ValueContext,
  effects: Effects,
): Malformed[] {
  const out: Malformed[] = [];
  const allocations = new Map<string, Leaf[]>();

  for (const leaf of leaves) {
    if (!isVisible(effects, leaf.path)) continue;
    if (leaf.field.type === "allocation") {
      const group = allocations.get(leaf.fieldPath);
      if (group) group.push(leaf);
      else allocations.set(leaf.fieldPath, [leaf]);
      continue;
    }
    const effective = effectiveValue(values, leaf.path);
    if (!effective.present) continue;
    const reason = malformedReason(leaf.field, effective.value);
    if (reason) out.push({ path: leaf.path, label: leaf.label, reason });
  }

  for (const [fieldPath, members] of allocations) {
    const field = members[0]?.field;
    if (field?.type !== "allocation") continue;
    const reason = allocationOverspend(field, members, values);
    if (reason) out.push({ path: fieldPath, label: field.label, reason });
  }

  return out;
}
