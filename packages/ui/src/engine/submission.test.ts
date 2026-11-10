/**
 * The submit payload (§4.6 "the user submits exactly what they see", §4.4
 * notes, §5.1 bulk affirm).
 */

import { assumptionLedger, elicitation } from "@mcpq/schema";
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
    // No unreviewed tally: five prefilled verdicts the user left standing are
    // five answers, and the payload says nothing about who put them there.
    expect(Object.keys(payload.summary).sort()).toEqual(["answered", "changed", "empty"]);
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

  it("does not blank the prefilled value it is anchored to", () => {
    // The bug a field session hit: annotating a field took the text out of the
    // input under it, for every input tried. A note is a touch, and the entry
    // the touch creates must carry what was on screen (§4.6) — not a bare
    // `empty`, which outranks the prefill and submits blank.
    const store = loaded(assumptionLedger);
    store.getState().setNote(verdict("r_eu"), "the UK org is in scope too");
    expect(answersOf(store)[verdict("r_eu")]).toEqual({
      state: "answered",
      value: "confirm",
      note: "the UK org is in scope too",
    });
    expect(submit(store).answers[verdict("r_eu")]).toEqual({
      state: "answered",
      value: "confirm",
      note: "the UK org is in scope too",
    });
  });

  it("does not blank a defaulted value either", () => {
    const store = loaded(elicitation);
    store.getState().setNote("tradeoff", "leaning fast, ask me again after the pilot");
    expect(submit(store).answers.tradeoff).toEqual({
      state: "answered",
      value: 3,
      note: "leaning fast, ask me again after the pilot",
    });
  });

  it("still anchors to an empty answer where no value is on screen", () => {
    const store = loaded(elicitation);
    store.getState().setNote("sandbox_name", "whatever Ops called it");
    expect(answersOf(store).sandbox_name).toEqual({
      state: "empty",
      note: "whatever Ops called it",
    });
  });

  it("keeps the value when the note is cleared again", () => {
    const store = loaded(assumptionLedger);
    store.getState().setNote(verdict("r_eu"), "typed then thought better of it");
    store.getState().setNote(verdict("r_eu"), "");
    expect(submit(store).answers[verdict("r_eu")]).toEqual({
      state: "answered",
      value: "confirm",
    });
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
    expect(line).toBe('"Before I draft the rollout plan…": 5 of 10 answered.');
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
