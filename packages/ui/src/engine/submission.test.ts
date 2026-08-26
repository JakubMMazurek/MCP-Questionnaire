/**
 * The submit payload (§4.6 "the user submits exactly what they see", §4.4
 * notes, §5.1 bulk affirm).
 */

import { assumptionLedger, elicitation } from "@gather/schema";
import { describe, expect, it } from "vitest";
import { answersOf, counter, ctx, loaded, submit } from "./harness.js";
import { mintRowId } from "./paths.js";
import { highConfidence, needsReviewPaths, summaryLine } from "./submission.js";

const verdict = (row: string) => `assumptions[${row}][verdict]`;
const ROWS = ["r_eu", "r_salesops", "r_cutover", "r_legacy", "r_revops"];

describe("visible untouched fields submit as answered (§4.6)", () => {
  it("submits every prefilled verdict the user saw", () => {
    const store = loaded(assumptionLedger);
    const payload = submit(store);
    for (const row of ROWS) {
      expect(payload.answers[verdict(row)]).toEqual({ state: "answered", value: "confirm" });
    }
    expect(payload.summary.answered).toBe(5);
    // The five hidden correction cells.
    expect(payload.summary.empty).toBe(5);
    expect(payload.summary.unreviewed).toBe(5);
  });

  it("submits a defaulted value the same way", () => {
    const store = loaded(elicitation);
    const payload = submit(store);
    expect(payload.answers.tradeoff).toEqual({ state: "answered", value: 3 });
  });

  it("enumerates unanswered fields as empty — partial submit is first-class (§5.6)", () => {
    const store = loaded(elicitation);
    const payload = submit(store);
    // `sandbox_name` is shown only for environment=sandbox, which IS the
    // prefilled value, so it is visible but unanswered.
    expect(payload.answers.sandbox_name).toEqual({ state: "empty" });
  });
});

describe("notes (§4.4)", () => {
  it("rides on an empty answer and carries the row label", () => {
    const store = loaded(assumptionLedger);
    store.getState().setNote("assumptions[r_cutover]", "depends on whether Legal signs off");
    const payload = submit(store);
    expect(payload.notes).toEqual([
      {
        path: "assumptions[r_cutover]",
        label: "Cutover happens outside UK business hours",
        note: "depends on whether Legal signs off",
      },
    ]);
    expect(payload.answers["assumptions[r_cutover]"]).toEqual({
      state: "empty",
      note: "depends on whether Legal signs off",
    });
  });

  it("survives on a field that also holds a value", () => {
    const store = loaded(assumptionLedger);
    store.getState().setAnswer(verdict("r_eu"), "fix");
    store.getState().setNote(verdict("r_eu"), "the UK org is in scope too");
    const payload = submit(store);
    expect(payload.answers[verdict("r_eu")]).toEqual({
      state: "answered",
      value: "fix",
      note: "the UK org is in scope too",
    });
    expect(payload.notes[0]?.label).toBe("Rollout targets the EU org only — Verdict");
  });

  it("is removed when the user empties the input", () => {
    const store = loaded(assumptionLedger);
    store.getState().setNote(verdict("r_eu"), "typed");
    store.getState().setNote(verdict("r_eu"), "");
    expect(submit(store).notes).toEqual([]);
  });
});

describe("bulk affirm (§5.1)", () => {
  it("selects exactly the needs-review prefills that are not low confidence", () => {
    const store = loaded(assumptionLedger);
    const paths = needsReviewPaths(ctx(store), highConfidence);
    expect(paths).toEqual([verdict("r_eu"), verdict("r_salesops"), verdict("r_legacy")]);
  });

  it("writes answered entries copying the prefill values, and nothing else", () => {
    const store = loaded(assumptionLedger);
    store.getState().bulkAffirm(needsReviewPaths(ctx(store), highConfidence));
    expect(Object.keys(answersOf(store)).sort()).toEqual(
      [verdict("r_eu"), verdict("r_salesops"), verdict("r_legacy")].sort(),
    );
    expect(answersOf(store)[verdict("r_eu")]).toEqual({ state: "answered", value: "confirm" });
    expect(counter(store, "unreviewed")).toBe(2);
  });

  it("affirms everything when the predicate is unrestricted", () => {
    const store = loaded(assumptionLedger);
    store.getState().bulkAffirm(needsReviewPaths(ctx(store)));
    expect(counter(store, "unreviewed")).toBe(0);
    expect(Object.keys(answersOf(store))).toHaveLength(5);
  });

  it("ignores paths with no prefill to copy", () => {
    const store = loaded(assumptionLedger);
    store.getState().bulkAffirm(["assumptions[r_eu][correction]"]);
    expect(answersOf(store)).toEqual({});
  });

  it("keeps a note that was already anchored to an affirmed path", () => {
    const store = loaded(assumptionLedger);
    store.getState().setNote(verdict("r_eu"), "fine as-is");
    store.getState().bulkAffirm([verdict("r_eu")]);
    expect(answersOf(store)[verdict("r_eu")]).toEqual({
      state: "answered",
      value: "confirm",
      note: "fine as-is",
    });
  });
});

describe("the model-context summary (§7.2)", () => {
  it("is a summary, not the payload", () => {
    const store = loaded(assumptionLedger);
    const line = summaryLine(assumptionLedger, submit(store).summary);
    expect(line).toBe(
      '"Before I draft the rollout plan…": 5 of 10 answered; 5 inferred values unreviewed.',
    );
    expect(line).not.toContain("confirm");
  });
});

describe("minted row ids (§4.5)", () => {
  it("mints r_ + base36 and never an all-digit tail", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = mintRowId();
      expect(id).toMatch(/^r_[a-z0-9]{4,}$/);
      expect(id.slice(2)).toMatch(/[a-z]/);
    }
  });

  it("survives a random source that only ever produces digits", () => {
    // Math.random() -> 0.95 lands in the digit range of the alphabet.
    const id = mintRowId(() => 0.95);
    expect(id.slice(2)).toMatch(/[a-z]/);
  });
});
