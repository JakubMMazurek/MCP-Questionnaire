/**
 * @vitest-environment jsdom
 *
 * `disable` and §4.6, which the build originally read as applying to `hide`
 * alone.
 *
 * Reported from a field session (2026-11-09): a number field was disabled by a
 * rule after the user had typed into it, kept the value on screen, and then
 * submitted it. Two separate faults sat behind that one sentence — the control
 * had no disabled face, so it read as a broken input rather than a locked one
 * (guarded in `scripts/verify-styles.mjs`), and the value it was still holding
 * reached the payload.
 *
 * The second is this file. "The user submits exactly what they see" has to mean
 * a value they can REACH: a control the rules have locked is not somewhere the
 * user can put an answer, so a disabled path reads empty on screen, to rule
 * reads and in the payload. The store entry survives, because re-enabling has
 * to restore it under the same clause that lets a re-shown field come back.
 */

import type { Form } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import {
  buildSubmission,
  createEngineStore,
  type EngineStore,
  effectiveValue,
} from "./engine/index.js";

/* The reported shape, reduced: one answer governs whether the other applies. */
const files = {
  version: 1,
  title: "Attachments",
  display: "inline",
  sections: [
    {
      id: "files",
      title: "Attachments",
      fields: [
        {
          type: "single_select",
          id: "strategy",
          label: "How do the files travel?",
          render: "radio",
          options: [
            { value: "after", label: "After cutover, backfilled by age" },
            { value: "link_out", label: "Left in place, linked out" },
          ],
        },
        {
          type: "number",
          id: "retain_months",
          label: "Months of files to bring",
          min: 0,
          max: 240,
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "strategy", op: "eq", value: "link_out" },
      then: { action: "disable", targets: ["retain_months"] },
    },
  ],
} satisfies Form;

function loaded(): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(files);
  return store;
}

const value = (store: EngineStore, path: string) => {
  const state = store.getState();
  return effectiveValue(
    { answers: state.answers, prefill: state.prefill, overlays: state.effects },
    path,
  );
};

const submitted = (store: EngineStore, path: string) => {
  const state = store.getState();
  return buildSubmission(files, state.answers, state.effects, state.prefill).answers[path];
};

describe("a disabled field is not somewhere the user can answer (§4.6)", () => {
  it("submits what the user typed while the field is still reachable", () => {
    const store = loaded();
    store.getState().setAnswer("strategy", "after");
    store.getState().setAnswer("retain_months", 24);

    expect(store.getState().effects.disabled.has("retain_months")).toBe(false);
    expect(value(store, "retain_months")).toEqual({
      present: true,
      value: 24,
      origin: "answer",
    });
    expect(submitted(store, "retain_months")).toEqual({ state: "answered", value: 24 });
  });

  it("stops carrying the value once a rule locks the field", () => {
    const store = loaded();
    store.getState().setAnswer("strategy", "after");
    store.getState().setAnswer("retain_months", 24);

    store.getState().setAnswer("strategy", "link_out");

    expect(store.getState().effects.disabled.has("retain_months")).toBe(true);
    // Not 24 greyed out on screen, and not 24 in the payload: this is the bug.
    expect(value(store, "retain_months")).toEqual({ present: false });
    expect(submitted(store, "retain_months")).toEqual({ state: "empty" });
  });

  it("gives the answer back when a rule unlocks the field again", () => {
    const store = loaded();
    store.getState().setAnswer("strategy", "after");
    store.getState().setAnswer("retain_months", 24);
    store.getState().setAnswer("strategy", "link_out");

    store.getState().setAnswer("strategy", "after");

    // Lossless, exactly as a re-shown field is: the user sees it before submitting.
    expect(value(store, "retain_months")).toEqual({
      present: true,
      value: 24,
      origin: "answer",
    });
    expect(submitted(store, "retain_months")).toEqual({ state: "answered", value: 24 });
  });
});
