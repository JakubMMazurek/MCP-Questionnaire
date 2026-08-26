/**
 * The `computed` ops (§4.2/§4.7). The two that carry the archetypes are
 * `count_needs_review` (any touch clears it, even confirming the same value)
 * and `count_changed` (a revert to the baseline counts as unchanged).
 */

import type { Computed } from "@gather/schema";
import { assumptionLedger, convergence, matrixFls } from "@gather/schema";
import { describe, expect, it } from "vitest";
import { compute, counter, loaded } from "./harness.js";

const verdict = (row: string) => `assumptions[${row}][verdict]`;
const cell = (field: string, profile: string) => `grid[${field}][${profile}]`;

describe("count_needs_review (§4.7)", () => {
  it("counts every unreviewed prefill on a fully prefilled form", () => {
    const store = loaded(assumptionLedger);
    expect(counter(store, "unreviewed")).toBe(5);
    // The point of the op: count_empty reads 0 on the same form.
    expect(compute(store, { op: "count_empty", targets: ["assumptions.verdict"] })).toBe(0);
  });

  it("clears on confirming the SAME value", () => {
    const store = loaded(assumptionLedger);
    store.getState().setAnswer(verdict("r_eu"), "confirm");
    expect(counter(store, "unreviewed")).toBe(4);
  });

  it("clears on a note alone — a note is a touch", () => {
    const store = loaded(assumptionLedger);
    store.getState().setNote(verdict("r_cutover"), "check with Legal");
    expect(counter(store, "unreviewed")).toBe(4);
  });

  it("clears on an explicit empty", () => {
    const store = loaded(assumptionLedger);
    store.getState().setEmpty(verdict("r_revops"));
    expect(counter(store, "unreviewed")).toBe(4);
  });
});

describe("count_value (§4.3 — defer is an ordinary option)", () => {
  it("counts prefilled values the user is looking at", () => {
    const store = loaded(assumptionLedger);
    expect(counter(store, "tbd")).toBe(0);
    store.getState().setAnswer(verdict("r_cutover"), "tbd");
    store.getState().setAnswer(verdict("r_revops"), "tbd");
    expect(counter(store, "tbd")).toBe(2);
  });

  it("counts booleans by equality across a table column", () => {
    const store = loaded(convergence);
    // Two rows carry `keep` prefills: true for r_selfserve, false for r_docs.
    expect(counter(store, "kept")).toBe(1);
    store.getState().setAnswer("candidates[r_pricing][keep]", true);
    expect(counter(store, "kept")).toBe(2);
  });
});

describe("count_changed vs the `existing` baseline (§4.7)", () => {
  it("starts at zero on an untouched baseline-prefilled grid", () => {
    const store = loaded(matrixFls);
    expect(counter(store, "changes")).toBe(0);
  });

  it("counts an edit and forgets it again on revert", () => {
    const store = loaded(matrixFls);
    store.getState().setAnswer(cell("Discount__c", "sales_ops"), "r");
    expect(counter(store, "changes")).toBe(1);
    store.getState().setAnswer(cell("Discount__c", "sales_ops"), "rw");
    expect(counter(store, "changes")).toBe(0);
  });

  it("counts a cell cleared to empty as changed", () => {
    const store = loaded(matrixFls);
    store.getState().setEmpty(cell("Discount__c", "support"));
    expect(counter(store, "changes")).toBe(1);
  });

  it("expands a container target to cells", () => {
    const store = loaded(matrixFls);
    // 4 rows × 3 cols, all baseline-prefilled.
    expect(compute(store, { op: "count_answered", targets: ["grid"] })).toBe(12);
  });
});

describe("count_answered / count_empty / sum", () => {
  it("treats a hidden leaf as empty", () => {
    const store = loaded(assumptionLedger);
    const all: Computed = { op: "count_answered", targets: ["assumptions"] };
    // Verdicts are prefilled and visible; corrections are hidden by the $self rule.
    expect(compute(store, all)).toBe(5);
    expect(compute(store, { op: "count_empty", targets: ["assumptions"] })).toBe(5);

    store.getState().setAnswer(verdict("r_eu"), "fix");
    store.getState().setAnswer("assumptions[r_eu][correction]", "the UK org too");
    expect(compute(store, all)).toBe(6);
    expect(compute(store, { op: "count_empty", targets: ["assumptions"] })).toBe(4);
  });

  it("sums numeric effective values only", () => {
    const store = loaded(matrixFls);
    expect(compute(store, { op: "sum", targets: ["grid"] })).toBe(0);
  });
});
