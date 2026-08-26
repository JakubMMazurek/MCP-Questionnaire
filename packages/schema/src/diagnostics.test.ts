/**
 * The formatted diagnostics are what the agent reads in the tool result (§6.3),
 * so they are snapshotted as a whole: a change to the wording is a change to a
 * product surface and should show up in review as one.
 */

import { describe, expect, it } from "vitest";
import { minimal } from "./__fixtures__/forms.js";
import { formatDiagnostics } from "./diagnostics.js";
import { validateAnswers, validateForm } from "./validate.js";

/** Fixtures are mutated as loose JSON on purpose: these tests exercise what the
 * validator does with malformed input, which is the whole point of §6.3. */
// biome-ignore lint/suspicious/noExplicitAny: loose-by-design test fixtures
type Mutable = Record<string, any>;

function tweak(mutate: (form: Mutable) => void): Mutable {
  const form = minimal();
  mutate(form as Mutable);
  return form;
}

describe("formatDiagnostics", () => {
  it("says so when there is nothing to report", () => {
    expect(formatDiagnostics([])).toBe("Form accepted — no problems found.");
  });

  it("renders a form with several errors", () => {
    const text = validateForm(
      tweak((form) => {
        form.sections[0].fields[0].type = "single_selct";
        form.sections[1].fields[0].helpText = "pick a date";
        form.rules = [
          {
            when: { field: "region", op: "eq" },
            then: { action: "show", targets: ["timing"] },
          },
        ];
      }),
    ).text;
    expect(text).toMatchSnapshot();
  });

  it("renders the ordinal teaching error — the §4.5 rule that prevents corruption", () => {
    const text = validateForm(
      tweak((form) => {
        form.sections[1].fields.push({
          id: "stakeholders",
          label: "Who signs off?",
          type: "repeatable",
          fields: [
            { id: "owner", label: "Name", type: "short_text" },
            { id: "role", label: "Role", type: "short_text" },
          ],
        });
        form.prefill["stakeholders[2].owner"] = {
          value: "Priya",
          source: "inferred",
        };
      }),
    ).text;
    expect(text).toMatchSnapshot();
  });

  it("renders a rules-only failure, naming every index", () => {
    const text = validateForm(
      tweak((form) => {
        form.rules = [
          {
            when: { field: "env", op: "filled" },
            then: { action: "filter_options", targets: ["scopeChoice"] },
          },
          {
            when: { field: "env", op: "in", value: "sandbox" },
            then: {
              action: "set_default",
              targets: ["scopeChoice"],
              value: "half_of_it",
            },
          },
          {
            when: { field: "scopeChoice", op: "empty" },
            then: { action: "hide", targets: ["env"], options: ["accounts"] },
          },
          {
            when: { field: "env", op: "empty" },
            then: { action: "hide", targets: ["scopeChoice"] },
          },
        ];
      }),
    ).text;
    expect(text).toMatchSnapshot();
  });

  it("renders warnings on a form that still renders", () => {
    const text = validateForm(
      tweak((form) => {
        form.sections[1].fields.pop();
        form.prefill = {};
      }),
    ).text;
    expect(text).toMatchSnapshot();
  });

  it("renders a matrix that cannot be drawn", () => {
    const text = validateForm(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "fls",
          label: "Discount fields — profile access",
          type: "matrix",
          cellType: "single_select",
          rows: [{ id: "Discount__c", label: "Discount" }],
          cols: [{ id: "SalesOps", label: "Sales Ops" }],
          constraints: [{ row: "Margin__c", col: "SalesOps" }],
        }),
      ),
    ).text;
    expect(text).toMatchSnapshot();
  });

  it("renders an answer map that came back malformed", () => {
    const form = validateForm(minimal()).form;
    if (!form) throw new Error("fixture must be valid");
    const text = validateAnswers(
      {
        env: { state: "empty", value: "sandbox" },
        "scopeChoice[1]": { state: "answered", value: "accounts" },
        notes: { state: "pending" },
      },
      form,
    ).text;
    expect(text).toMatchSnapshot();
  });
});
