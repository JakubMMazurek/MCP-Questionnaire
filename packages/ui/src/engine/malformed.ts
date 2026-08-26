/**
 * The only thing that may block submit (§6.3).
 *
 * `require` marks, it never gates — partial submit is always available (§5.6).
 * A MALFORMED value is different: a short_text that fails its declared
 * `pattern`, a number outside its declared bounds. Sending those back would
 * hand the agent data its own schema says is impossible, so submit waits until
 * the user fixes them. Hidden leaves are exempt: they submit `empty`.
 */

import { isVisible } from "./computed.js";
import { effectiveValue, type ValueContext } from "./effective.js";
import type { Effects } from "./evaluate.js";
import type { Leaf } from "./leaves.js";

export type Malformed = { path: string; label: string; reason: string };

function checkLeaf(leaf: Leaf, value: unknown): string | null {
  const field = leaf.field;
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
  }
  return null;
}

/** Every visible leaf whose value the form's own schema rejects. */
export function malformedValues(
  leaves: readonly Leaf[],
  values: ValueContext,
  effects: Effects,
): Malformed[] {
  const out: Malformed[] = [];
  for (const leaf of leaves) {
    if (!isVisible(effects, leaf.path)) continue;
    const effective = effectiveValue(values, leaf.path);
    if (!effective.present) continue;
    const reason = checkLeaf(leaf, effective.value);
    if (reason) out.push({ path: leaf.path, label: leaf.label, reason });
  }
  return out;
}
