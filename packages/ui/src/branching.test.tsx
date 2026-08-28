/**
 * @vitest-environment jsdom
 *
 * The branching example, executed (§4.6).
 *
 * `conditionalBranching` is shipped as a worked example by `get_form_guide`, so
 * the claims its comments make are promises to whoever copies it. Validating it
 * proves only that it parses. These tests run it: one branch visible at a time,
 * a section shared by two branches via `in`, a filter cascade that un-answers a
 * stale choice on its own, `require` that marks without gating, `set_default`
 * that never overwrites, and `clear` firing on the edge and not on the level.
 *
 * The last one is the one worth having a test for: what the user cannot see does
 * not submit, whatever the store is still holding (§4.6).
 */

import { conditionalBranching } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import {
  buildSubmission,
  createEngineStore,
  type EngineStore,
  effectiveValue,
  isVisible,
} from "./engine/index.js";

function loaded(): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(conditionalBranching);
  return store;
}

/** The sections and the fields we care about, in one call. */
function visible(store: EngineStore, paths: readonly string[]): string[] {
  const { effects } = store.getState();
  return paths.filter((path) => isVisible(effects, path));
}

const BRANCHES = ["basic_details", "key_details", "oauth_details", "endpoint"] as const;

const value = (store: EngineStore, path: string) => {
  const state = store.getState();
  return effectiveValue(
    { answers: state.answers, prefill: state.prefill, overlays: state.effects },
    path,
  );
};

describe("branching by one answer (§4.6)", () => {
  it("opens exactly the branch the answer names", () => {
    const store = loaded();
    // The form arrives with `api_key` prefilled, so its branch is already open —
    // which is the point of prefilling: the user lands on a form that has
    // already made a proposal, not on three collapsed possibilities.
    expect(visible(store, BRANCHES)).toEqual(["key_details", "endpoint"]);

    store.getState().setAnswer("auth_method", "basic");
    expect(visible(store, BRANCHES)).toEqual(["basic_details"]);

    store.getState().setAnswer("auth_method", "oauth");
    expect(visible(store, BRANCHES)).toEqual(["oauth_details", "endpoint"]);
  });

  it("shows the fields inside the branch, not just its heading", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "oauth");
    expect(visible(store, ["client_id", "token_url", "scopes", "pkce"])).toHaveLength(4);
    expect(visible(store, ["username", "key_header"])).toEqual([]);
  });

  it("closes every branch when the user defers instead of choosing", () => {
    const store = loaded();
    // `you_decide` is an ordinary skip option (§4.3) — no rule names it, so no
    // branch matches, and the agent reads the deferral and picks.
    store.getState().setAnswer("auth_method", "you_decide");
    expect(visible(store, BRANCHES)).toEqual([]);
  });
});

describe("what a hidden branch submits (§4.6)", () => {
  it("submits empty for the branch the user left, whatever the store holds", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "basic");
    store.getState().setAnswer("username", "svc_warehouse");
    store.getState().setAnswer("auth_method", "api_key");

    // Still in the store, so flipping back does not lose the typing…
    expect(store.getState().answers.username).toEqual({
      state: "answered",
      value: "svc_warehouse",
    });
    // …and absent from the payload, because the payload is a function of the
    // rendered view and nothing else.
    const state = store.getState();
    const submission = buildSubmission(
      conditionalBranching,
      state.answers,
      state.effects,
      state.prefill,
      { rows: state.rows, leaves: state.leaves },
    );
    expect(submission.answers.username).toEqual({ state: "empty" });
    expect(submission.answers.key_header).toMatchObject({ state: "answered" });
  });
});

describe("the filter_options cascade", () => {
  it("narrows the datacentre to the region's own", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "api_key");
    // `region` is prefilled `eu`.
    store.getState().setAnswer("datacenter", "eu_west");
    expect(value(store, "datacenter")).toMatchObject({ present: true, value: "eu_west" });
  });

  it("un-answers a datacentre the new region does not offer, with no clear rule", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "api_key");
    store.getState().setAnswer("datacenter", "eu_west");
    store.getState().setAnswer("region", "us");
    // The stored value survives, but it no longer survives its filter, so every
    // read of it — the control, the counters, the payload — sees absent.
    expect(value(store, "datacenter")).toEqual({ present: false });
  });
});

describe("require, set_default and clear", () => {
  it("marks the change ticket required only in production", () => {
    const store = loaded();
    expect(store.getState().effects.required.get("change_ticket")).toBeUndefined();
    store.getState().setAnswer("environment", "production");
    expect(store.getState().effects.required.get("change_ticket")).toBe(true);
    expect(visible(store, ["production_gate", "change_ticket"])).toHaveLength(2);
  });

  it("required marks and never gates — a blank required field still submits", () => {
    const store = loaded();
    store.getState().setAnswer("environment", "production");
    const state = store.getState();
    const submission = buildSubmission(
      conditionalBranching,
      state.answers,
      state.effects,
      state.prefill,
      { rows: state.rows, leaves: state.leaves },
    );
    expect(submission.answers.change_ticket).toEqual({ state: "empty" });
  });

  it("proposes a dry run into an empty field, and does not overrule an answer", () => {
    const store = loaded();
    store.getState().setAnswer("environment", "production");
    expect(value(store, "dry_run")).toMatchObject({ value: true, origin: "default" });

    store.getState().setAnswer("dry_run", false);
    expect(value(store, "dry_run")).toMatchObject({ value: false, origin: "answer" });
  });

  it("clears the host on the way back to sandbox, and only on the edge", () => {
    const store = loaded();
    // `base_url` lives in the shared endpoint section, so it stays on screen
    // across the switch — which is the only kind of target a `clear` is for. A
    // clear aimed at a field the same switch hides would be redundant: what is
    // not rendered already submits empty.
    store.getState().setAnswer("environment", "production");
    store.getState().setAnswer("base_url", "https://prod.warehouse.example");
    expect(value(store, "base_url")).toMatchObject({ value: "https://prod.warehouse.example" });

    // false -> true on the sandbox condition: the clear fires.
    store.getState().setAnswer("environment", "sandbox");
    expect(store.getState().answers.base_url).toBeUndefined();
    expect(visible(store, ["base_url"])).toEqual(["base_url"]);

    // Still sandbox. A level-triggered rule would blank this again on the next
    // evaluation; this one must not, or the field could never be typed into.
    store.getState().setAnswer("base_url", "https://sandbox.warehouse.example");
    store.getState().setNote("dry_run", "another store write, another evaluation");
    expect(value(store, "base_url")).toMatchObject({
      value: "https://sandbox.warehouse.example",
    });
  });

  /** `loadForm` evaluates with clears suppressed, or a hydrated draft would be
   * wiped by any clear rule whose condition happens to hold on arrival. */
  it("does not fire a clear on the form's first evaluation", () => {
    const store = createEngineStore();
    // `environment` is prefilled `sandbox`, so the clear's condition holds the
    // moment the form loads.
    store.getState().loadForm(conditionalBranching);
    store.getState().hydrate({
      base_url: { state: "answered", value: "https://kept.example" },
      auth_method: { state: "answered", value: "api_key" },
    });
    expect(value(store, "base_url")).toMatchObject({ value: "https://kept.example" });
  });
});

/**
 * The multi_select pair (§4.6), written from the field report that produced it.
 *
 * An agent branched a section on "pepperoni is among the toppings" with
 * `{ op: "in", value: ["pepperoni"] }`, the only shape the vocabulary then
 * offered. `in` compares the field's WHOLE value to each candidate, so it put an
 * array against a string, was false forever, and the section never appeared —
 * with no error anywhere, which is the part that made it expensive.
 */
describe("membership on a multi_select (§4.6)", () => {
  const form = {
    version: 1 as const,
    title: "Pizza",
    sections: [
      {
        id: "order",
        title: "Order",
        fields: [
          {
            type: "multi_select" as const,
            id: "toppings",
            label: "Toppings",
            options: [
              { value: "pepperoni", label: "Pepperoni" },
              { value: "mushroom", label: "Mushroom" },
              { value: "pineapple", label: "Pineapple" },
            ],
          },
          {
            type: "info" as const,
            id: "meat_note",
            label: "About the pepperoni",
            markdown: "Cured meat on a shared pizza — worth checking with the table.",
          },
          {
            type: "info" as const,
            id: "veg_note",
            label: "Vegetarian, then",
            markdown: "No meat selected, so this one can go to the veggie stack.",
          },
        ],
      },
    ],
    rules: [
      {
        when: { field: "toppings", op: "contains" as const, value: "pepperoni" },
        then: { action: "show" as const, targets: ["meat_note"] },
      },
      {
        when: { field: "toppings", op: "not_contains" as const, value: "pepperoni" },
        then: { action: "show" as const, targets: ["veg_note"] },
      },
    ],
  };

  const store = () => {
    const s = createEngineStore();
    s.getState().loadForm(form);
    return s;
  };

  it("fires on one chosen value among several", () => {
    const s = store();
    expect(visible(s, ["meat_note", "veg_note"])).toEqual([]);

    s.getState().setAnswer("toppings", ["mushroom", "pepperoni", "pineapple"]);
    expect(visible(s, ["meat_note", "veg_note"])).toEqual(["meat_note"]);
  });

  it("negates, and order never matters", () => {
    const s = store();
    s.getState().setAnswer("toppings", ["pineapple", "mushroom"]);
    expect(visible(s, ["meat_note", "veg_note"])).toEqual(["veg_note"]);

    s.getState().setAnswer("toppings", ["pepperoni", "mushroom"]);
    expect(visible(s, ["meat_note", "veg_note"])).toEqual(["meat_note"]);
    s.getState().setAnswer("toppings", ["mushroom", "pepperoni"]);
    expect(visible(s, ["meat_note", "veg_note"])).toEqual(["meat_note"]);
  });

  /**
   * Neither fires on an untouched field — the §4.6 invariant that a rule cannot
   * react to a field the user has not reached. `not_contains` is a comparison,
   * not a presence test: `empty` is the presence test.
   */
  it("stays quiet on an empty selection, negation included", () => {
    const s = store();
    expect(visible(s, ["meat_note", "veg_note"])).toEqual([]);
  });

  /**
   * The list forms, as a truth table — the point being that each op has exactly
   * one reading, since the ambiguity of a single overloaded `contains` is the
   * reason there are three of them.
   */
  describe("the list forms", () => {
    const shownBy = (op: string, value: unknown, selection: string[]): boolean => {
      const s = createEngineStore();
      s.getState().loadForm({
        ...form,
        rules: [
          {
            when: { field: "toppings", op, value },
            then: { action: "show" as const, targets: ["meat_note"] },
          },
        ],
      });
      s.getState().setAnswer("toppings", selection);
      return visible(s, ["meat_note"]).length === 1;
    };

    const PAIR = ["pepperoni", "mushroom"];

    it("contains_all holds only when every listed value is present", () => {
      expect(shownBy("contains_all", PAIR, ["pepperoni", "mushroom"])).toBe(true);
      // Order-insensitive, and extras do not spoil it: superset, not equality.
      expect(shownBy("contains_all", PAIR, ["mushroom", "pineapple", "pepperoni"])).toBe(true);
      expect(shownBy("contains_all", PAIR, ["pepperoni"])).toBe(false);
      expect(shownBy("contains_all", PAIR, ["pineapple"])).toBe(false);
    });

    it("contains_any holds on one hit", () => {
      expect(shownBy("contains_any", PAIR, ["pineapple", "mushroom"])).toBe(true);
      expect(shownBy("contains_any", PAIR, ["pepperoni"])).toBe(true);
      expect(shownBy("contains_any", PAIR, ["pineapple"])).toBe(false);
    });

    it("contains_none is the intersection being empty, not the negation of all", () => {
      expect(shownBy("contains_none", PAIR, ["pineapple"])).toBe(true);
      // One hit is enough to fail it — this is the distinction that a
      // "not_contains_all" op would have blurred, which is why there isn't one.
      expect(shownBy("contains_none", PAIR, ["pineapple", "mushroom"])).toBe(false);
      expect(shownBy("contains_none", PAIR, ["pepperoni", "mushroom"])).toBe(false);
    });

    /**
     * §4.6: a rule cannot fire on a field the user has not reached, and that
     * governs even where the predicate would be vacuously true. `contains_none`
     * of anything is trivially true of an empty selection — and still does not
     * fire, because "they have not answered" is what `empty` is for.
     */
    it("stays false on an unanswered field, contains_none included", () => {
      const s = createEngineStore();
      s.getState().loadForm({
        ...form,
        rules: [
          {
            when: { field: "toppings", op: "contains_none" as const, value: PAIR },
            then: { action: "show" as const, targets: ["meat_note"] },
          },
        ],
      });
      expect(visible(s, ["meat_note"])).toEqual([]);
    });
  });

  /** `eq` on a set is set equality, so tap order cannot decide it either. */
  it("treats eq on a multi_select as a set, not a sequence", () => {
    const s = createEngineStore();
    s.getState().loadForm({
      ...form,
      rules: [
        {
          when: { field: "toppings", op: "eq" as const, value: ["pepperoni", "mushroom"] },
          then: { action: "show" as const, targets: ["meat_note"] },
        },
      ],
    });
    s.getState().setAnswer("toppings", ["mushroom", "pepperoni"]);
    expect(visible(s, ["meat_note"])).toEqual(["meat_note"]);

    s.getState().setAnswer("toppings", ["mushroom", "pepperoni", "pineapple"]);
    expect(visible(s, ["meat_note"])).toEqual([]);
  });
});

/**
 * The `contains` branch inside the shipped worked example, executed.
 *
 * `conditionalBranching` is what `get_form_guide` hands an agent to copy, so its
 * demonstration of the op has to actually work — the whole reason the op exists
 * is that the previous vocabulary looked like it worked and did not.
 */
describe("the worked example's multi_select branch (§4.6)", () => {
  const ADMIN = ["admin_scope", "admin_justification", "admin_approver"] as const;

  it("asks why admin only once admin is among the scopes", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "oauth");
    expect(visible(store, ADMIN)).toEqual([]);

    store.getState().setAnswer("scopes", ["read", "write"]);
    expect(visible(store, ADMIN)).toEqual([]);

    store.getState().setAnswer("scopes", ["read", "admin"]);
    expect(visible(store, ADMIN)).toEqual(["admin_scope", "admin_justification", "admin_approver"]);
    expect(store.getState().effects.required.get("admin_justification")).toBe(true);

    // And it un-asks, because `show` is the only thing holding it open.
    store.getState().setAnswer("scopes", ["read"]);
    expect(visible(store, ADMIN)).toEqual([]);
  });

  /**
   * The section closes when the field it depends on stops being rendered: drop
   * back to an API key and `scopes` is not on screen, so it is empty, so
   * `contains` is false (§4.6). No cleanup rule required.
   */
  it("closes when the field it depends on is no longer rendered", () => {
    const store = loaded();
    store.getState().setAnswer("auth_method", "oauth");
    store.getState().setAnswer("scopes", ["admin"]);
    expect(visible(store, ADMIN)).toEqual(["admin_scope", "admin_justification", "admin_approver"]);

    store.getState().setAnswer("auth_method", "api_key");
    expect(visible(store, ADMIN)).toEqual([]);
  });
});
