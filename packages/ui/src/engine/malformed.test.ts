/**
 * The submit gate (§6.3): `require` marks and never blocks, so the ONLY thing
 * that may hold submit back is a value the form's own schema rejects.
 */

import type { Form } from "@gather/schema";
import { FORM_SCHEMA_VERSION } from "@gather/schema";
import { describe, expect, it } from "vitest";
import { loaded } from "./harness.js";
import { malformedValues } from "./malformed.js";

const form = {
  version: FORM_SCHEMA_VERSION,
  title: "Malformed values",
  description: "a pattern and a bounded number, so submit has something to refuse.",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        {
          type: "short_text",
          id: "ticket",
          label: "Ticket",
          required: true,
          pattern: "^[A-Z]{2,4}-\\d+$",
        },
        { type: "number", id: "days", label: "Days", min: 1, max: 30 },
        { type: "short_text", id: "free", label: "Anything" },
        {
          type: "matrix",
          id: "hours",
          label: "Hours",
          cellType: "number",
          cellMin: 0,
          cellMax: 40,
          rows: [{ id: "week1", label: "Week 1" }],
          cols: [{ id: "alice", label: "Alice" }],
          skipOptions: [{ value: "tbd", label: "TBD" }],
        },
      ],
    },
  ],
} satisfies Form;

function offences(store: ReturnType<typeof loaded>) {
  const state = store.getState();
  return malformedValues(
    state.leaves,
    { answers: state.answers, prefill: state.prefill, overlays: state.effects },
    state.effects,
  );
}

describe("malformedValues", () => {
  it("finds nothing on an untouched form — required is not malformed", () => {
    expect(offences(loaded(form))).toEqual([]);
  });

  it("flags a value its declared pattern rejects", () => {
    const store = loaded(form);
    store.getState().setAnswer("ticket", "nope");
    expect(offences(store)).toEqual([
      { path: "ticket", label: "Ticket", reason: "does not match the expected format" },
    ]);
    store.getState().setAnswer("ticket", "OPS-1420");
    expect(offences(store)).toEqual([]);
  });

  it("flags a number outside its declared bounds", () => {
    const store = loaded(form);
    store.getState().setAnswer("days", 90);
    expect(offences(store)[0]?.reason).toBe("is above the maximum of 30");
    store.getState().setAnswer("days", 0);
    expect(offences(store)[0]?.reason).toBe("is below the minimum of 1");
  });

  it("flags a matrix number cell outside its declared cell bounds", () => {
    const store = loaded(form);
    store.getState().setAnswer("hours[week1][alice]", 55);
    expect(offences(store)[0]?.reason).toBe("is above the maximum of 40");
    store.getState().setAnswer("hours[week1][alice]", 40);
    expect(offences(store)).toEqual([]);
  });

  it("never flags an agent-declared skip scalar in a number cell", () => {
    const store = loaded(form);
    store.getState().setAnswer("hours[week1][alice]", "tbd");
    expect(offences(store)).toEqual([]);
  });

  it("never blocks on an empty answer, however required", () => {
    const store = loaded(form);
    store.getState().setEmpty("ticket");
    expect(offences(store)).toEqual([]);
  });
});
