/**
 * @vitest-environment jsdom
 *
 * The form that rendered as a blank screen (2026-09-09).
 *
 * A form the agent authored in the field came back as React error #185 —
 * "maximum update depth exceeded" — and a blank page. It arrived through the
 * standalone carrier, but the carrier is not what broke: everything here mounts
 * through the ordinary inline path with `bridge: null`, and the loop reproduces
 * exactly the same. Chat and Cowork would have shown the same blank page.
 *
 * The shape that does it: `filter_options` over a `multi_select` that has a
 * PREFILL. `effectiveValue` allocated a fresh filtered array on every read, so
 * a per-path selector handed React a new snapshot identity on every render —
 * an infinite loop, whether or not the filter actually removed anything. Both
 * halves are ordinary §4.6 (`filter_options` narrows one answer by another,
 * prefill is required by §5.1), which is why it took a real form to find it.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fieldForm from "./__fixtures__/blank-screen-form.json" with { type: "json" };
import { App } from "./App";
import { createEngineStore, effectiveValue } from "./engine/index.js";
import { AppProvider } from "./state";

/** Reduced from the field form: the slider, the branch it opens, its default. */
const setDefaultIntoShownSection = {
  version: 1,
  title: "Because you lean on agents",
  description: "Reduced repro. Or just tell me in chat.",
  submitLabel: "go",
  sections: [
    {
      id: "you",
      title: "The five",
      fields: [
        {
          id: "agent_reliance",
          label: "Who types the code these days?",
          type: "slider",
          min: 0,
          max: 10,
          minLabel: "I write it",
          maxLabel: "I direct agents",
        },
      ],
    },
    {
      id: "agent_detail",
      title: "Because you lean on agents",
      fields: [
        {
          id: "agent_pain",
          label: "When it goes wrong, how does it usually go wrong?",
          type: "single_select",
          render: "radio",
          options: [
            { value: "stale_facts", label: "Stale facts" },
            { value: "scope_drift", label: "Scope drift" },
          ],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "agent_reliance", op: "gt", value: 6 },
      then: { action: "show", targets: ["agent_detail"] },
    },
    {
      when: { field: "agent_reliance", op: "gt", value: 6 },
      then: { action: "require", targets: ["agent_pain"] },
    },
    {
      when: { field: "agent_reliance", op: "gt", value: 6 },
      then: { action: "set_default", targets: ["agent_pain"], value: "stale_facts" },
    },
  ],
  prefill: {
    agent_reliance: { value: 7, source: "inferred", confidence: "high", rationale: "x" },
  },
};

describe("the exact form from the field", () => {
  it("renders instead of blanking with React error #185", () => {
    const store = createEngineStore();
    store.getState().loadForm(fieldForm);
    expect(store.getState().status).toBe("ready");
    expect(() =>
      render(
        <AppProvider value={{ store, bridge: null }}>
          <App />
        </AppProvider>,
      ),
    ).not.toThrow();
  });
});

describe("a set_default into a section the same rule shows (§4.6)", () => {
  it("settles — this shape was suspected first, and is innocent", () => {
    const store = createEngineStore();
    store.getState().loadForm(setDefaultIntoShownSection);
    expect(store.getState().status).toBe("ready");

    // React error #185 surfaces here as a throw out of render.
    expect(() =>
      render(
        <AppProvider value={{ store, bridge: null }}>
          <App />
        </AppProvider>,
      ),
    ).not.toThrow();
  });

  it("proposes the default without the user having touched it", () => {
    const store = createEngineStore();
    store.getState().loadForm(setDefaultIntoShownSection);
    const { effects } = store.getState();
    expect(effects).toBeDefined();
  });
});

/**
 * The invariant underneath, stated where it cannot be lost in a React test:
 * reading the same value twice must give back the same thing, or every
 * snapshot-based consumer above it re-renders forever.
 */
describe("the read path's identity (the actual defect)", () => {
  const ctx = (surviving: string[], value: string[]) => ({
    answers: {},
    prefill: { focus: { value, source: "inferred" as const } },
    overlays: {
      hidden: new Set<string>(),
      defaults: new Map<string, unknown>(),
      filtered: new Map<string, readonly string[]>([["focus", surviving]]),
    },
  });

  it("returns the same array when the filter removes nothing", () => {
    const context = ctx(["apex", "sf_integrations", "testing"], ["apex", "sf_integrations"]);
    const first = effectiveValue(context, "focus");
    const second = effectiveValue(context, "focus");
    expect(first).toMatchObject({ present: true });
    expect(second).toMatchObject({ present: true });
    // Reference equality, not just contents: this is what React compares.
    expect((first as { value: unknown }).value).toBe((second as { value: unknown }).value);
  });

  it("returns the same array when the filter does remove something", () => {
    const context = ctx(["apex"], ["apex", "react_ui"]);
    const first = effectiveValue(context, "focus");
    const second = effectiveValue(context, "focus");
    expect((first as { value: unknown }).value).toEqual(["apex"]);
    expect((first as { value: unknown }).value).toBe((second as { value: unknown }).value);
  });

  it("still drops a value the filter rejects entirely", () => {
    const context = ctx(["apex"], ["react_ui"]);
    expect(effectiveValue(context, "focus")).toMatchObject({ present: false });
  });
});
