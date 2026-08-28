/**
 * The submit payload (§4.6, §4.4, §5.6).
 *
 * "The user submits exactly what they see." Every leaf in the form appears:
 * a visible leaf with an effective value submits `answered` — even if the user
 * never touched it, because the prefilled or defaulted value was on screen and
 * they submitted it — and a hidden leaf submits `empty` no matter what the store
 * still holds for it. Notes travel as `{path, label, note}` triples so the agent
 * can open on them instead of re-reading a blob (§4.4).
 */

import type { Answer, Answers, Form, Prefill } from "@mcpq/schema";
import { resolvePath } from "@mcpq/schema";
import { type ComputeContext, isChanged, isVisible, needsReview } from "./computed.js";
import { effectiveValue, type ValueContext } from "./effective.js";
import type { Effects } from "./evaluate.js";
import { formLeaves, type Leaf, type RowMap } from "./leaves.js";
import { canon } from "./paths.js";

export type NoteTriple = { path: string; label: string; note: string };

/**
 * There is deliberately no "unreviewed" count here.
 *
 * A prefilled value is a convenience — a guess put on screen so the user has
 * something to correct instead of something to author. If they submitted with it
 * showing, it is their answer; §4.6 already says the payload is a function of
 * the rendered view, and nothing in `Answer` distinguishes a value they typed
 * from one they let stand, because nothing should.
 *
 * The tally used to travel to the agent, which invited the one behaviour this
 * whole tool exists to prevent: re-asking in prose about a value the user has
 * already accepted. `needsReview` keeps its job on the surface the user sees —
 * the provenance chip, the count_needs_review counter, bulk affirm — where it
 * directs attention rather than reopening a settled question.
 *
 * `changed` stays, because it is not about attention: it says the user moved a
 * value away from a `source: "existing"` baseline, which is a fact about the
 * world the agent is about to act on.
 */
export type SubmissionSummary = {
  /** Visible leaves that will submit a value. */
  answered: number;
  /** Leaves that will submit `empty` — including every hidden one. */
  empty: number;
  /** Leaves that differ from their `source: "existing"` baseline. */
  changed: number;
};

export type Submission = {
  formId?: string;
  answers: Answers;
  notes: NoteTriple[];
  summary: SubmissionSummary;
};

export type SubmissionOptions = { rows?: RowMap; leaves?: readonly Leaf[] };

/** Human label for a path — the field's, or the row's for a row-anchored note. */
export function labelFor(form: Form, leaves: readonly Leaf[], path: string): string {
  const leaf = leaves.find((candidate) => candidate.path === path);
  if (leaf) return leaf.label;

  const resolved = resolvePath(form, path);
  if (!resolved.ok) return path;
  const target = resolved.target;
  switch (target.kind) {
    case "row": {
      const row =
        target.container.type === "table"
          ? target.container.rows.find((r) => r.id === target.rowId)
          : undefined;
      return row?.label ?? target.rowId;
    }
    case "field":
      return target.field.type === "info"
        ? (target.field.label ?? target.field.id)
        : target.field.label;
    case "section":
      return target.section.title;
    case "matrix_row":
      return target.row.label;
    case "matrix_cell":
      return `${target.row.label} · ${target.col.label}`;
    case "rank_item":
      return target.item.label;
    case "allocation_member":
      return target.member.label;
  }
}

/**
 * Builds the payload. `prefill` is passed in (rather than read off the form) so
 * a caller can submit against the exact envelope the store was hydrated with.
 */
export function buildSubmission(
  form: Form,
  answers: Answers,
  effects: Effects,
  prefill: Readonly<Record<string, Prefill>>,
  options: SubmissionOptions = {},
): Submission {
  const leaves = options.leaves ?? formLeaves(form, options.rows ?? {});
  const values: ValueContext = {
    answers,
    prefill,
    overlays: { hidden: effects.hidden, defaults: effects.defaults, filtered: effects.filtered },
  };
  const ctx: ComputeContext = { form, leaves, answers, prefill, effects };

  const out: Answers = {};
  const notes: NoteTriple[] = [];
  let answered = 0;
  let empty = 0;

  let changed = 0;

  for (const leaf of leaves) {
    const note = answers[leaf.path]?.note;
    const effective = effectiveValue(values, leaf.path);
    const entry: Answer = effective.present
      ? { state: "answered", value: effective.value, ...(note ? { note } : {}) }
      : { state: "empty", ...(note ? { note } : {}) };
    out[leaf.path] = entry;

    if (effective.present) answered += 1;
    else empty += 1;
    if (isVisible(effects, leaf.path) && isChanged(ctx, leaf)) changed += 1;
  }

  // Notes may be anchored to a path that holds no answer at all — a table row,
  // an `info` block (§4.4/§5.4). Those ride along as `empty` entries so the
  // anchor survives the trip.
  for (const [path, entry] of Object.entries(answers)) {
    if (!entry.note) continue;
    notes.push({ path, label: labelFor(form, leaves, path), note: entry.note });
    if (out[path] === undefined) out[path] = { state: "empty", note: entry.note };
  }

  return {
    ...(form.formId ? { formId: form.formId } : {}),
    answers: out,
    notes,
    summary: { answered, empty, changed },
  };
}

/**
 * The counts alone — no title. The submit receipt names the form itself and
 * would say it twice otherwise.
 */
export function countsLine(summary: SubmissionSummary): string {
  const total = summary.answered + summary.empty;
  const parts = [`${summary.answered} of ${total} answered`];
  if (summary.changed > 0) parts.push(`${summary.changed} changed from current`);
  return `${parts.join("; ")}.`;
}

/**
 * The one-line progress summary pushed to `ui/update-model-context` (§7.2).
 * A SUMMARY, never the payload — mid-fill context discipline is the whole point.
 */
export function summaryLine(form: Form, summary: SubmissionSummary): string {
  return `"${form.title}": ${countsLine(summary)}`;
}

/** Paths whose prefill still needs review, for bulk affirm (§5.1). */
export function needsReviewPaths(
  ctx: ComputeContext,
  predicate: (prefill: Prefill) => boolean = () => true,
): string[] {
  return ctx.leaves
    .filter((leaf) => needsReview(ctx, leaf) && predicate(ctx.prefill[leaf.path] as Prefill))
    .map((leaf) => leaf.path);
}

/**
 * The predicate behind "Confirm all high-confidence" (§5.1 mockup): everything
 * except explicitly LOW-confidence inferences. `user` and `existing` values
 * carry no `confidence` and are high-confidence by provenance, so the label and
 * the behaviour agree — which is why the predicate is a parameter and not a
 * constant buried in the button.
 */
export function highConfidence(prefill: Prefill): boolean {
  return prefill.confidence !== "low";
}

/** Canonicalises a caller-supplied path (agents may write either syntax). */
export { canon };
