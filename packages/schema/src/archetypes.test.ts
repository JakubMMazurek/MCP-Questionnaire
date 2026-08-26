/**
 * Build step 2 — the archetype audit (§8 of DESIGN.html).
 *
 * Every §5 archetype, written out in full in `__fixtures__/archetypes.ts`, must
 * validate. Each block also records what the archetype could NOT express
 * directly and the workaround the recipe uses — those notes are audit output,
 * not incidental comments.
 */

import { describe, expect, it } from "vitest";
import { archetypes } from "./__fixtures__/archetypes.js";
import { formatDiagnostics } from "./diagnostics.js";
import { validateForm } from "./validate.js";

function expectAccepted(name: keyof typeof archetypes, allowedWarnings: string[] = []) {
  const result = validateForm(archetypes[name]);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  if (errors.length > 0 || warnings.some((w) => !allowedWarnings.includes(w.code))) {
    // Surface the teaching output — the audit reads it, and it doubles as a
    // review of the error surface itself.
    throw new Error(formatDiagnostics(result.diagnostics));
  }
  expect(result.ok).toBe(true);
  return { warnings };
}

describe("archetype audit (§5 → §4)", () => {
  it("5.1 assumption ledger — columns+data, per-row $self rule, review counter", () => {
    // Audit note: row provenance has no row-level home BY DESIGN — verdicts are
    // prefilled `confirm` with source/confidence/rationale/needsReview, so the
    // chip, the counter and bulk affirm all read the §4.7 envelope. This needed
    // the `count_needs_review` computed op (prefilled-needsReview answers the
    // user hasn't touched yet); `count_empty` says 0 on a fully-prefilled form.
    expectAccepted("assumptionLedger");
  });

  it("5.2 elicitation — inline, skipOptions, filter_options, tradeoff slider", () => {
    expectAccepted("elicitation");
  });

  it("5.3 convergence — table not multi_select; ranking is the next chained form", () => {
    // Audit notes:
    //  - Rejection reasons need per-candidate rules, so candidates are a table
    //    with a boolean `keep` column and a `$self`-scoped reason select. A
    //    multi_select can't do it: rule ops have no membership test over
    //    multi-valued answers (recorded as a recipe rule, not a schema gap).
    //  - `rank` items are declared at authoring time, so ranking the survivors
    //    is the NEXT form in the chain (§5.6), prefilled from this one.
    expectAccepted("convergence");
  });

  it("5.3 convergence, form two — the chained rank + allocation (§5.6)", () => {
    // Added at build step 5. Audit notes:
    //  - This is the form the step-2 audit said had to exist: `rank` items are
    //    declared at authoring time, so the survivors cannot be ranked in the
    //    same form that prunes them. Continuity is IDS — the rank items and the
    //    allocation members reuse the prune's row ids — plus the formId the
    //    agent passes forward (§5.6), not a prose summary.
    //  - `sum` over an allocation names the FIELD, not its members: the target
    //    expands to cells, the same container expansion `count_changed` needs.
    //  - `set_default` over the allocation shows the §4.6 overlay doing real
    //    work: an even split is PROPOSED without writing answers, so a user
    //    edit still wins and the proposal vanishes when the condition flips.
    expectAccepted("convergenceRank");

    const form = archetypes.convergenceRank;
    const rank = form.sections[0]?.fields[2];
    const allocation = form.sections[1]?.fields[2];
    const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);
    if (rank?.type !== "rank" || allocation?.type !== "allocation") {
      throw new Error("the chained form must carry a rank and an allocation");
    }
    // The hand-off, asserted rather than described: same ids on both sides, and
    // the same ids the prune's table rows used.
    expect(ids(rank.items)).toEqual(ids(allocation.members));
    const kept = archetypes.convergence.sections[0]?.fields[1];
    if (kept?.type !== "table") throw new Error("the prune must be a table");
    expect(ids(kept.rows)).toEqual(expect.arrayContaining(ids(rank.items)));
  });

  it("5.4 plan confirmation — info-with-id + verdict select per section", () => {
    // Audit note: expressible and correct, but verbose — info + verdict +
    // conditional revision text per plan part, plus one rule each. A 10-part
    // plan is ~30 fields and 10 rules. Tolerable for v1; the recipe should cap
    // plan parts per form rather than the schema growing a compound type.
    expectAccepted("planConfirmation");
  });

  it("count_needs_review warns when nothing is marked for review", () => {
    const ledger = archetypes.assumptionLedger;
    const stripped = {
      ...ledger,
      prefill: Object.fromEntries(
        Object.entries(ledger.prefill).map(([path, entry]) => [
          path,
          { ...entry, needsReview: false },
        ]),
      ),
    };
    const result = validateForm(stripped);
    expect(result.diagnostics.map((d) => d.code)).toContain("computed_nothing_to_review");
  });

  it("5.5 matrix — one cellType, constraints, existing-baseline, count_changed over the grid", () => {
    // Audit note: `count_changed` targets the matrix by its bare field id and
    // must count every cell against its `source: "existing"` prefill —
    // container targets expand to cells. Enumerating 12 (or 800) cell paths in
    // a computed would defeat the columns+data economy.
    expectAccepted("matrixFls");
  });
});
