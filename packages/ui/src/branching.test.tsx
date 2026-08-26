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
