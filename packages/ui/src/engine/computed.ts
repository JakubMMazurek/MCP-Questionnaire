/**
 * The `computed` ops (§4.1/§4.2) — a closed vocabulary, no expression language.
 *
 * Every op counts over EFFECTIVE values, which is what makes a counter agree
 * with what the user is looking at and with what submit will send: a visible
 * prefilled field counts as answered because it will submit as answered, and a
 * hidden field counts as empty because it will submit as empty (§4.6).
 *
 * Targets may name a container or a column and expand to cells — the same
 * subsequence match the validator uses (`withinTarget`).
 */

import type { Answers, Computed, Form, Prefill, Value } from "@gather/schema";
import { baselineOf, effectiveValue, sameValue, type ValueContext } from "./effective.js";
import type { Effects } from "./evaluate.js";
import type { Leaf } from "./leaves.js";
import { canon, withinTarget } from "./paths.js";

export type ComputeContext = {
  form: Form;
  leaves: readonly Leaf[];
  answers: Answers;
  prefill: Readonly<Record<string, Prefill>>;
  effects: Effects;
};

/** A path is visible unless a rule hid it (or hid its section or field). */
export function isVisible(effects: Effects, path: string): boolean {
  return !effects.hidden.has(path);
}

function valueContext(ctx: ComputeContext): ValueContext {
  return {
    answers: ctx.answers,
    prefill: ctx.prefill,
    overlays: {
      hidden: ctx.effects.hidden,
      defaults: ctx.effects.defaults,
      filtered: ctx.effects.filtered,
    },
  };
}

/**
 * Leaves a computed target covers. A target that names a section expands to
 * that section's leaves; anything else uses the container/column subsequence
 * match, so `assumptions` and `assumptions.verdict` both expand to cells.
 */
export function leavesFor(
  ctx: Pick<ComputeContext, "form" | "leaves">,
  targets: readonly string[],
): Leaf[] {
  const out: Leaf[] = [];
  for (const leaf of ctx.leaves) {
    const covered = targets.some((target) => {
      const section = ctx.form.sections.find((s) => s.id === target);
      return section ? leaf.section === section : withinTarget(leaf.path, target);
    });
    if (covered) out.push(leaf);
  }
  return out;
}

/** True when the leaf's answer differs from its `source: "existing"` baseline (§4.7). */
export function isChanged(ctx: ComputeContext, leaf: Leaf): boolean {
  // Untouched is never changed — a prefilled value the user never opened is not
  // an edit, whatever its provenance.
  if (ctx.answers[leaf.path] === undefined) return false;
  const baseline = baselineOf(ctx.prefill, leaf.path);
  const effective = effectiveValue(valueContext(ctx), leaf.path);
  if (!baseline) return effective.present;
  return !(effective.present && sameValue(effective.value, baseline.value));
}

/** True when the leaf still carries an unreviewed inference (§4.7). */
export function needsReview(ctx: ComputeContext, leaf: Leaf): boolean {
  if (!isVisible(ctx.effects, leaf.path)) return false;
  if (ctx.answers[leaf.path] !== undefined) return false;
  return ctx.prefill[leaf.path]?.needsReview === true;
}

function matchesValue(value: unknown, wanted: Value): boolean {
  // A `multi_select` answer is a set: "count answers whose value is X" means
  // "count the ones that include X" there, equality everywhere else.
  return Array.isArray(value)
    ? value.some((item) => sameValue(item, wanted))
    : sameValue(value, wanted);
}

/** Evaluates one `computed` field's op. Always a number (§4.2). */
export function computeValue(ctx: ComputeContext, compute: Computed): number {
  const leaves = leavesFor(ctx, compute.targets.map(canon));
  const values = valueContext(ctx);
  const effectiveOf = (leaf: Leaf) => effectiveValue(values, leaf.path);

  switch (compute.op) {
    case "count_value": {
      let n = 0;
      for (const leaf of leaves) {
        const effective = effectiveOf(leaf);
        if (effective.present && matchesValue(effective.value, compute.value)) n += 1;
      }
      return n;
    }
    case "count_empty":
      return leaves.filter((leaf) => !effectiveOf(leaf).present).length;
    case "count_answered":
      return leaves.filter((leaf) => effectiveOf(leaf).present).length;
    case "count_changed":
      return leaves.filter((leaf) => isVisible(ctx.effects, leaf.path) && isChanged(ctx, leaf))
        .length;
    case "count_needs_review":
      return leaves.filter((leaf) => needsReview(ctx, leaf)).length;
    case "sum": {
      let total = 0;
      for (const leaf of leaves) {
        const effective = effectiveOf(leaf);
        if (effective.present && typeof effective.value === "number") total += effective.value;
      }
      return total;
    }
  }
}
