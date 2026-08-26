/**
 * Small purpose-built forms for the engine tests. The archetypes
 * (`@gather/schema`'s fixtures) cover the real shapes; these isolate one rule
 * mechanic each, which is the only way to test the cap and the `clear` edge
 * without a form that also happens to be a good form.
 */

import type { Form } from "@gather/schema";
import { FORM_SCHEMA_VERSION } from "@gather/schema";

const pick = (id: string, label: string) => ({
  type: "single_select" as const,
  id,
  label,
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
});

/** show / hide / set_default / clear over three plain fields. */
export const gate = {
  version: FORM_SCHEMA_VERSION,
  title: "Gate",
  description: "show, set_default and clear over one condition.",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        pick("mode", "Mode"),
        { type: "short_text", id: "detail", label: "Detail" },
        { type: "short_text", id: "always", label: "Always here" },
      ],
    },
  ],
  rules: [
    {
      when: { field: "mode", op: "eq", value: "a" },
      then: { action: "show", targets: ["detail"] },
    },
    {
      when: { field: "mode", op: "eq", value: "a" },
      then: { action: "set_default", targets: ["detail"], value: "suggested" },
    },
  ],
  prefill: { always: { value: "kept", source: "existing" } },
} satisfies Form;

/** `clear` on the transition into "b". */
export const clearer = {
  version: FORM_SCHEMA_VERSION,
  title: "Clearer",
  description: "clear is edge-triggered.",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [pick("mode", "Mode"), { type: "short_text", id: "detail", label: "Detail" }],
    },
  ],
  rules: [
    {
      when: { field: "mode", op: "eq", value: "b" },
      then: { action: "clear", targets: ["detail"] },
    },
  ],
} satisfies Form;

/** `filter_options` narrowing a select the user has already answered. */
export const filtered = {
  version: FORM_SCHEMA_VERSION,
  title: "Filtered",
  description: "filter_options is half the value (§4.6).",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        pick("cloud", "Cloud"),
        {
          type: "single_select",
          id: "region",
          label: "Region",
          options: [
            { value: "eu", label: "EU" },
            { value: "us", label: "US" },
          ],
        },
      ],
    },
  ],
  rules: [
    {
      when: { field: "cloud", op: "eq", value: "a" },
      then: { action: "filter_options", targets: ["region"], options: ["eu"] },
    },
  ],
} satisfies Form;

/** Three rules that must chain: answering `one` reveals `two` reveals `three`. */
export const chained = {
  version: FORM_SCHEMA_VERSION,
  title: "Chained",
  description: "a rule whose condition only becomes true because of an earlier rule.",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        pick("one", "One"),
        { type: "short_text", id: "two", label: "Two" },
        { type: "short_text", id: "three", label: "Three" },
        { type: "short_text", id: "four", label: "Four" },
      ],
    },
  ],
  rules: [
    { when: { field: "one", op: "eq", value: "a" }, then: { action: "show", targets: ["two"] } },
    { when: { field: "two", op: "filled" }, then: { action: "show", targets: ["three"] } },
    { when: { field: "three", op: "filled" }, then: { action: "show", targets: ["four"] } },
  ],
  prefill: {
    two: { value: "prefilled two", source: "inferred" },
    three: { value: "prefilled three", source: "inferred" },
  },
} satisfies Form;

/**
 * A deliberate oscillation: hiding `y` makes it read empty, which defaults `x`
 * to 2, which shows `y`, which stops the default, which hides `y` again. The
 * engine must stop at the cap rather than spin (§4.6).
 */
export const cyclic = {
  version: FORM_SCHEMA_VERSION,
  title: "Cyclic",
  description: "a rule list with no fixed point.",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        { type: "number", id: "x", label: "X" },
        { type: "number", id: "y", label: "Y" },
        { type: "short_text", id: "spare", label: "Spare" },
      ],
    },
  ],
  rules: [
    {
      when: { field: "y", op: "empty" },
      then: { action: "set_default", targets: ["x"], value: 2 },
    },
    { when: { field: "x", op: "eq", value: 2 }, then: { action: "show", targets: ["y"] } },
  ],
  prefill: { x: { value: 1, source: "inferred" }, y: { value: 5, source: "inferred" } },
} satisfies Form;
