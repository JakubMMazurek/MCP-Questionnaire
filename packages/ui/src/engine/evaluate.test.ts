/**
 * The rules engine's contract (§4.6). Every test here is a semantic the spec
 * decides — "not rendered = empty", the derived `set_default` overlay, the
 * `clear` edge, the iteration cap, per-row `$self`.
 */

import { assumptionLedger, convergence } from "@gather/schema";
import { describe, expect, it } from "vitest";
import { chained, clearer, cyclic, filtered, gate } from "./__fixtures__/rules.js";
import { evaluate, MAX_ITERATIONS } from "./evaluate.js";
import { answersOf, loaded, submit } from "./harness.js";

const DETAIL = "detail";

describe("visibility — not rendered = empty (§4.6)", () => {
  it("hides a show-target until its condition holds", () => {
    const store = loaded(gate);
    expect(store.getState().effects.hidden.has(DETAIL)).toBe(true);
    store.getState().setAnswer("mode", "a");
    expect(store.getState().effects.hidden.has(DETAIL)).toBe(false);
  });

  it("submits empty for a hidden field while the store keeps the answer", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    store.getState().setAnswer(DETAIL, "typed by hand");
    expect(submit(store).answers[DETAIL]).toEqual({ state: "answered", value: "typed by hand" });

    store.getState().setAnswer("mode", "b");
    expect(submit(store).answers[DETAIL]).toEqual({ state: "empty" });
    // The store retains it — hiding is not deleting.
    expect(answersOf(store)[DETAIL]).toEqual({ state: "answered", value: "typed by hand" });
  });

  it("submits the value again when the field is re-shown", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    store.getState().setAnswer(DETAIL, "typed by hand");
    store.getState().setAnswer("mode", "b");
    store.getState().setAnswer("mode", "a");
    expect(submit(store).answers[DETAIL]).toEqual({ state: "answered", value: "typed by hand" });
  });

  it("reads a hidden field as empty when a rule tests it", () => {
    // `two` is prefilled but hidden, so rule 2's `filled` test must be false.
    const store = loaded(chained);
    expect(store.getState().effects.hidden.has("two")).toBe(true);
    expect(store.getState().effects.hidden.has("three")).toBe(true);
  });
});

describe("set_default is a derived overlay (§4.6)", () => {
  it("fills an empty field without writing to the store", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    expect(store.getState().effects.defaults.get(DETAIL)).toBe("suggested");
    expect(answersOf(store)[DETAIL]).toBeUndefined();
    expect(submit(store).answers[DETAIL]).toEqual({ state: "answered", value: "suggested" });
  });

  it("never clobbers a user edit, before or after the rule fires again", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    store.getState().setAnswer(DETAIL, "mine");
    expect(submit(store).answers[DETAIL]).toEqual({ state: "answered", value: "mine" });

    // Flip away and back: the overlay reappears but the answer still wins.
    store.getState().setAnswer("mode", "b");
    store.getState().setAnswer("mode", "a");
    expect(store.getState().effects.defaults.get(DETAIL)).toBe("suggested");
    expect(submit(store).answers[DETAIL]).toEqual({ state: "answered", value: "mine" });
  });

  it("disappears when its condition flips", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    expect(store.getState().effects.defaults.has(DETAIL)).toBe(true);
    store.getState().setAnswer("mode", "b");
    expect(store.getState().effects.defaults.has(DETAIL)).toBe(false);
  });

  it("does not overwrite an explicit empty (the user cleared it on purpose)", () => {
    const store = loaded(gate);
    store.getState().setAnswer("mode", "a");
    store.getState().setEmpty(DETAIL);
    expect(submit(store).answers[DETAIL]).toEqual({ state: "empty" });
  });
});

describe("clear is edge-triggered", () => {
  it("fires once on the false→true transition", () => {
    const store = loaded(clearer);
    store.getState().setAnswer(DETAIL, "first");
    store.getState().setAnswer("mode", "b");
    expect(answersOf(store)[DETAIL]).toBeUndefined();
  });

  it("does not keep clearing while the condition stays true", () => {
    const store = loaded(clearer);
    store.getState().setAnswer("mode", "b");
    store.getState().setAnswer(DETAIL, "typed after the clear");
    expect(answersOf(store)[DETAIL]).toEqual({ state: "answered", value: "typed after the clear" });
    // Another unrelated mutation must not re-fire it.
    store.getState().setNote("mode", "unrelated");
    expect(answersOf(store)[DETAIL]).toEqual({ state: "answered", value: "typed after the clear" });
  });

  it("fires again on the next transition", () => {
    const store = loaded(clearer);
    store.getState().setAnswer("mode", "b");
    store.getState().setAnswer(DETAIL, "kept");
    store.getState().setAnswer("mode", "a");
    expect(answersOf(store)[DETAIL]).toEqual({ state: "answered", value: "kept" });
    store.getState().setAnswer("mode", "b");
    expect(answersOf(store)[DETAIL]).toBeUndefined();
  });

  it("does not fire on load, when nothing transitioned", () => {
    const store = loaded(clearer);
    store.getState().hydrate({
      mode: { state: "answered", value: "b" },
      detail: { state: "answered", value: "from a draft" },
    });
    expect(answersOf(store)[DETAIL]).toEqual({ state: "answered", value: "from a draft" });
  });
});

describe("filter_options (§4.6)", () => {
  it("makes a filtered-out answer effectively empty without deleting it", () => {
    const store = loaded(filtered);
    store.getState().setAnswer("region", "us");
    store.getState().setAnswer("cloud", "a");
    expect(store.getState().effects.filtered.get("region")).toEqual(["eu"]);
    expect(submit(store).answers.region).toEqual({ state: "empty" });
    expect(answersOf(store).region).toEqual({ state: "answered", value: "us" });
  });

  it("restores the answer when the filter lifts", () => {
    const store = loaded(filtered);
    store.getState().setAnswer("region", "us");
    store.getState().setAnswer("cloud", "a");
    store.getState().setAnswer("cloud", "b");
    expect(submit(store).answers.region).toEqual({ state: "answered", value: "us" });
  });
});

describe("fixed point and the iteration cap (§4.6)", () => {
  it("chains rules until the view is stable", () => {
    const store = loaded(chained);
    store.getState().setAnswer("one", "a");
    const effects = store.getState().effects;
    expect(effects.hidden.has("two")).toBe(false);
    expect(effects.hidden.has("three")).toBe(false);
    expect(effects.hidden.has("four")).toBe(false);
    expect(effects.capped).toBe(false);
    expect(effects.iterations).toBeGreaterThan(2);
  });

  it("stops a cycle at the cap instead of hanging", () => {
    const effects = evaluate(cyclic, {});
    expect(effects.capped).toBe(true);
    expect(effects.iterations).toBe(MAX_ITERATIONS);
  });

  it("is pure — the same inputs give the same answer twice", () => {
    const once = evaluate(gate, { mode: { state: "answered", value: "a" } });
    const twice = evaluate(gate, { mode: { state: "answered", value: "a" } });
    expect([...twice.hidden]).toEqual([...once.hidden]);
    expect([...twice.defaults]).toEqual([...once.defaults]);
    expect(twice.iterations).toBe(once.iterations);
  });
});

describe("$self expands per row (§4.6)", () => {
  const verdict = (row: string) => `assumptions[${row}][verdict]`;
  const correction = (row: string) => `assumptions[${row}][correction]`;

  it("hides every row's correction until that row asks for a fix", () => {
    const store = loaded(assumptionLedger);
    for (const row of ["r_eu", "r_salesops", "r_cutover", "r_legacy", "r_revops"]) {
      expect(store.getState().effects.hidden.has(correction(row))).toBe(true);
    }
  });

  it("applies independently per row", () => {
    const store = loaded(assumptionLedger);
    store.getState().setAnswer(verdict("r_eu"), "fix");
    const hidden = store.getState().effects.hidden;
    expect(hidden.has(correction("r_eu"))).toBe(false);
    expect(hidden.has(correction("r_salesops"))).toBe(true);
    expect(hidden.has(correction("r_cutover"))).toBe(true);
  });

  it("instantiates only in containers that declare the member", () => {
    // convergence declares a `$self.keep` rule against the `candidates` table
    // and a separate `additions` repeatable with no `keep` column: the rule must
    // not instantiate there.
    const store = loaded(convergence);
    store.getState().addRow("additions");
    const keys = [...store.getState().effects.conditions.keys()];
    expect(keys.some((key) => key.startsWith("0@candidates["))).toBe(true);
    expect(keys.some((key) => key.startsWith("0@additions["))).toBe(false);
  });
});

describe("the store's touch invariant", () => {
  it("creates no entries from prefill", () => {
    const store = loaded(assumptionLedger);
    expect(answersOf(store)).toEqual({});
  });

  it("keys entries canonically whichever syntax the caller used", () => {
    const store = loaded(assumptionLedger);
    store.getState().setAnswer("assumptions[r_eu].verdict", "fix");
    expect(answersOf(store)["assumptions[r_eu][verdict]"]).toEqual({
      state: "answered",
      value: "fix",
    });
  });
});
