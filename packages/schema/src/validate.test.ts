import { describe, expect, it } from "vitest";
import { kitchenSink, minimal } from "./__fixtures__/forms.js";
import type { DiagnosticCode } from "./diagnostics.js";
import type { Form } from "./types.js";
import { validateAnswers, validateForm } from "./validate.js";
import { FIELD_TYPES } from "./vocab.js";

/** Fixtures are mutated as loose JSON on purpose: these tests exercise what the
 * validator does with malformed input, which is the whole point of §6.3. */
// biome-ignore lint/suspicious/noExplicitAny: loose-by-design test fixtures
type Mutable = Record<string, any>;

/** The minimal form, with one thing changed. */
function tweak(mutate: (form: Mutable) => void): Mutable {
  const form = minimal();
  mutate(form as Mutable);
  return form;
}

function codes(input: unknown): DiagnosticCode[] {
  return validateForm(input).diagnostics.map((d) => d.code);
}

function firstWith(input: unknown, code: DiagnosticCode) {
  const found = validateForm(input).diagnostics.find((d) => d.code === code);
  if (!found) {
    throw new Error(
      `expected a "${code}" diagnostic, got: ${JSON.stringify(codes(input))}\n${validateForm(input).text}`,
    );
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe("validateForm — happy path", () => {
  it("accepts a form using every field type, with nothing to warn about", () => {
    const result = validateForm(kitchenSink());
    expect(result.text).toBe("Form accepted — no problems found.");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.form).not.toBeNull();
  });

  it("covers all 16 field types in the fixture, so nothing goes unexercised", () => {
    const form = validateForm(kitchenSink()).form as Form;
    const seen = new Set<string>();
    const walk = (fields: readonly { type: string }[]): void => {
      for (const field of fields) {
        seen.add(field.type);
        const nested = field as {
          fields?: { type: string }[];
          columns?: { type: string }[];
        };
        if (nested.fields) walk(nested.fields);
        if (nested.columns) walk(nested.columns);
      }
    };
    for (const section of form.sections) walk(section.fields);
    expect([...FIELD_TYPES].filter((type) => !seen.has(type))).toEqual([]);
  });

  it("accepts the small inline elicitation form", () => {
    const result = validateForm(minimal());
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("accepts a server-minted formId on the way back out", () => {
    const result = validateForm(tweak((form) => (form.formId = "f_8Kd93mQz")));
    expect(result.ok).toBe(true);
    expect(result.form?.formId).toBe("f_8Kd93mQz");
  });
});

/* -------------------------------------------------------------------------- */
/* closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

describe("closed vocabularies (§4.1)", () => {
  it("rejects an unknown field type and suggests the closest", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.sections[0].fields[0].type = "single_selct")),
      "unknown_field_type",
    );
    expect(diagnostic.location).toBe('sections[0].fields[0].type "env"');
    expect(diagnostic.message).toContain('Did you mean "single_select"?');
    expect(diagnostic.message).toContain("closed vocabulary");
  });

  it("rejects an unknown render hint and lists the ones the type takes", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.sections[0].fields[0].render = "buttons")),
      "unknown_render_hint",
    );
    expect(diagnostic.message).toContain('"segmented"');
    expect(diagnostic.location).toContain("render");
  });

  it("rejects an unknown rule op", () => {
    const diagnostic = firstWith(
      tweak(
        (form) =>
          (form.rules = [
            {
              when: { field: "env", op: "matches", value: "x" },
              then: { action: "show", targets: ["notes"] },
            },
          ]),
      ),
      "unknown_rule_op",
    );
    expect(diagnostic.message).toContain("no boolean trees");
  });

  it("rejects an unknown rule action", () => {
    firstWith(
      tweak(
        (form) =>
          (form.rules = [
            {
              when: { field: "env", op: "filled" },
              then: { action: "highlight", targets: ["notes"] },
            },
          ]),
      ),
      "unknown_rule_action",
    );
  });

  it("rejects an unknown computed op — there is no expression language", () => {
    const diagnostic = firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "score",
          label: "Score",
          type: "computed",
          compute: { op: "average", targets: ["env"] },
        }),
      ),
      "unknown_computed_op",
    );
    expect(diagnostic.message).toContain("no expression language");
  });

  it("requires a value on count_value", () => {
    firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "score",
          label: "Score",
          type: "computed",
          compute: { op: "count_value", targets: ["env"] },
        }),
      ),
      "computed_value_required",
    );
  });

  it("rejects an unknown matrix cellType", () => {
    firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "grid",
          label: "Grid",
          type: "matrix",
          cellType: "dropdown",
          rows: [{ id: "a", label: "A" }],
          cols: [{ id: "b", label: "B" }],
        }),
      ),
      "unknown_cell_type",
    );
  });

  it("rejects an unknown prefill source", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.prefill.env.source = "guessed")),
      "unknown_prefill_source",
    );
    expect(diagnostic.message).toContain('"inferred"');
  });

  it("rejects an unsupported envelope version", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.version = 2)),
      "unsupported_version",
    );
    expect(diagnostic.location).toBe("version");
  });

  it("rejects an unknown property rather than ignoring it", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.sections[0].fields[0].helpText = "type carefully")),
      "unknown_property",
    );
    expect(diagnostic.message).toContain('"helpText"');
    expect(diagnostic.message).toContain("description");
  });

  it("rejects an object as an option value — values are matched by equality", () => {
    expect(
      codes(tweak((form) => (form.sections[0].fields[0].options[0].value = { id: "sandbox" }))),
    ).toContain("malformed");
  });
});

/* -------------------------------------------------------------------------- */
/* identity                                                                   */
/* -------------------------------------------------------------------------- */

describe("ids are addresses (§4.5)", () => {
  it("rejects duplicate section ids", () => {
    firstWith(
      tweak((form) => (form.sections[1].id = "setup")),
      "duplicate_section_id",
    );
  });

  it("rejects duplicate field ids across sections", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.sections[1].fields[0].id = "env")),
      "duplicate_field_id",
    );
    expect(diagnostic.message).toContain("bare path");
  });

  it("rejects a field id that collides with a section id", () => {
    firstWith(
      tweak((form) => (form.sections[0].fields[0].id = "timing")),
      "id_collision",
    );
  });

  it("rejects duplicate member ids inside a field", () => {
    firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "effort",
          label: "Effort",
          type: "allocation",
          total: 100,
          members: [
            { id: "a", label: "A" },
            { id: "a", label: "Also A" },
          ],
        }),
      ),
      "duplicate_member_id",
    );
  });

  it("rejects duplicate table row ids", () => {
    firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "ledger",
          label: "Assumptions",
          type: "table",
          columns: [
            {
              id: "verdict",
              label: "Verdict",
              type: "single_select",
              options: [{ value: "ok", label: "OK" }],
            },
          ],
          rows: [
            { id: "r_1", label: "One" },
            { id: "r_1", label: "Also one" },
          ],
        }),
      ),
      "duplicate_row_id",
    );
  });

  it("rejects an all-digit row id, which is indistinguishable from an ordinal", () => {
    const diagnostic = firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "ledger",
          label: "Assumptions",
          type: "table",
          columns: [
            {
              id: "verdict",
              label: "Verdict",
              type: "single_select",
              options: [{ value: "ok", label: "OK" }],
            },
          ],
          rows: [{ id: "2", label: "Row two" }],
        }),
      ),
      "malformed",
    );
    expect(diagnostic.message).toContain("r_7f3a");
  });

  it("rejects two options sharing a value, including across skipOptions", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.sections[0].fields[0].skipOptions[0].value = "sandbox")),
      "duplicate_option_value",
    );
    expect(diagnostic.message).toContain("return trip");
  });
});

/* -------------------------------------------------------------------------- */
/* rules                                                                      */
/* -------------------------------------------------------------------------- */

function withRules(rules: unknown[]): Mutable {
  return tweak((form) => (form.rules = rules));
}

describe("rules (§4.6)", () => {
  it("rejects a when.field that does not resolve", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "region", op: "filled" },
          then: { action: "show", targets: ["notes"] },
        },
      ]),
      "unresolved_path",
    );
    expect(diagnostic.location).toBe("rules[0].when.field");
    expect(diagnostic.message).toContain('"env"');
  });

  it("rejects a then.target that does not resolve", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: { action: "show", targets: ["nope"] },
        },
      ]),
      "unresolved_path",
    );
    expect(diagnostic.location).toBe("rules[0].then.targets[0]");
  });

  it("rejects an ordinal in a rule path with the teaching error", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push({
        id: "stakeholders",
        label: "Who signs off?",
        type: "repeatable",
        fields: [{ id: "owner", label: "Name", type: "short_text" }],
      });
      f.rules = [
        {
          when: { field: "stakeholders[2].owner", op: "filled" },
          then: { action: "show", targets: ["notes"] },
        },
      ];
    });
    const diagnostic = firstWith(form, "ordinal_path");
    expect(diagnostic.message).toContain("minted row id");
  });

  it("requires a value for eq", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "eq" },
          then: { action: "show", targets: ["notes"] },
        },
      ]),
      "rule_value_required",
    );
  });

  it("forbids a value on empty/filled", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled", value: "sandbox" },
          then: { action: "show", targets: ["notes"] },
        },
      ]),
      "rule_value_forbidden",
    );
  });

  it("requires an array for in", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "in", value: "sandbox" },
          then: { action: "show", targets: ["notes"] },
        },
      ]),
      "rule_in_requires_array",
    );
  });

  it("rejects a condition that can never be true", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "env", op: "eq", value: "staging" },
          then: { action: "show", targets: ["notes"] },
        },
      ]),
      "rule_option_not_declared",
    );
    expect(diagnostic.message).toContain("never be true");
  });

  it("requires filter_options to say which options survive", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: { action: "filter_options", targets: ["scopeChoice"] },
        },
      ]),
      "rule_payload_required",
    );
    expect(diagnostic.message).toContain("half of the mechanic people forget");
  });

  it("requires set_default to carry a value", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: { action: "set_default", targets: ["notes"] },
        },
      ]),
      "rule_payload_required",
    );
  });

  it("rejects filter_options on a field with no options", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: {
            action: "filter_options",
            targets: ["notes"],
            options: ["x"],
          },
        },
      ]),
      "rule_target_has_no_options",
    );
  });

  it("rejects filter_options that introduces an undeclared value", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: {
            action: "filter_options",
            targets: ["scopeChoice"],
            options: ["accounts", "contacts"],
          },
        },
      ]),
      "rule_option_not_declared",
    );
  });

  it("rejects a default that is not one of the field's values", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: {
            action: "set_default",
            targets: ["scopeChoice"],
            value: "some_of_it",
          },
        },
      ]),
      "rule_default_not_an_option",
    );
  });

  it("warns about a payload the action ignores", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: { action: "show", targets: ["notes"], value: "anything" },
        },
      ]),
      "rule_payload_ignored",
    );
    expect(diagnostic.severity).toBe("warning");
  });

  it("rejects set_default against a section", () => {
    firstWith(
      withRules([
        {
          when: { field: "env", op: "filled" },
          then: { action: "set_default", targets: ["timing"], value: "x" },
        },
      ]),
      "rule_action_target_mismatch",
    );
  });

  it("rejects a rule that targets a whole row", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push({
        id: "stakeholders",
        label: "Who signs off?",
        type: "repeatable",
        fields: [{ id: "owner", label: "Name", type: "short_text" }],
      });
      f.rules = [
        {
          when: { field: "env", op: "filled" },
          then: { action: "hide", targets: ["stakeholders[r_1]"] },
        },
      ];
    });
    const diagnostic = firstWith(form, "rule_action_target_mismatch");
    expect(diagnostic.message).toContain("$self");
  });

  it("warns when rules could cycle", () => {
    const diagnostic = firstWith(
      withRules([
        {
          when: { field: "env", op: "empty" },
          then: { action: "hide", targets: ["scopeChoice"] },
        },
        {
          when: { field: "scopeChoice", op: "empty" },
          then: { action: "hide", targets: ["env"] },
        },
      ]),
      "rule_cycle",
    );
    expect(diagnostic.severity).toBe("warning");
    expect(diagnostic.message).toContain("iteration cap");
  });

  it("does not warn about a plain chain of rules", () => {
    expect(
      codes(
        withRules([
          {
            when: { field: "env", op: "eq", value: "prod" },
            then: { action: "show", targets: ["timing"] },
          },
          {
            when: { field: "cutover", op: "filled" },
            then: { action: "show", targets: ["notes"] },
          },
        ]),
      ),
    ).not.toContain("rule_cycle");
  });

  it("warns when $self resolves in more than one container", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push(
        {
          id: "stakeholders",
          label: "Who signs off?",
          type: "repeatable",
          fields: [{ id: "owner", label: "Name", type: "short_text" }],
        },
        {
          id: "ledger",
          label: "Assumptions",
          type: "table",
          columns: [{ id: "owner", label: "Owner", type: "short_text" }],
          rows: [{ id: "r_1", label: "One" }],
        },
      );
      f.rules = [
        {
          when: { field: "$self.owner", op: "filled" },
          then: { action: "show", targets: ["notes"] },
        },
      ];
    });
    const diagnostic = firstWith(form, "self_scope_ambiguous");
    expect(diagnostic.severity).toBe("warning");
  });
});

/* -------------------------------------------------------------------------- */
/* computed                                                                   */
/* -------------------------------------------------------------------------- */

describe("computed (§4.2)", () => {
  const withComputed = (compute: unknown) =>
    tweak((form) =>
      form.sections[1].fields.push({
        id: "counter",
        label: "Counter",
        type: "computed",
        compute,
      }),
    );

  it("rejects a count_value nobody can ever satisfy", () => {
    const diagnostic = firstWith(
      withComputed({ op: "count_value", targets: ["env"], value: "lets_talk" }),
      "computed_value_not_declared",
    );
    expect(diagnostic.message).toContain("only ever read zero");
  });

  it("rejects summing something that is not a number", () => {
    const diagnostic = firstWith(
      withComputed({ op: "sum", targets: ["env"] }),
      "computed_target_not_numeric",
    );
    expect(diagnostic.message).toContain("count_value");
  });

  it("warns when count_changed has no existing baseline", () => {
    const diagnostic = firstWith(
      withComputed({ op: "count_changed", targets: ["env"] }),
      "computed_needs_baseline",
    );
    expect(diagnostic.message).toContain('source "existing"');
  });

  it("accepts count_changed against an existing prefill", () => {
    const form = withComputed({
      op: "count_changed",
      targets: ["scopeChoice"],
    });
    (form.prefill as Mutable).scopeChoice = {
      value: "accounts",
      source: "existing",
    };
    expect(codes(form)).not.toContain("computed_needs_baseline");
  });

  it("warns when a counter counts a read-only field", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push(
        { id: "plan", type: "info", markdown: "## Plan" },
        {
          id: "counter",
          label: "Counter",
          type: "computed",
          compute: { op: "count_answered", targets: ["plan"] },
        },
      );
    });
    firstWith(form, "computed_target_read_only");
  });
});

/* -------------------------------------------------------------------------- */
/* matrix and table                                                           */
/* -------------------------------------------------------------------------- */

describe("matrix (§5.5) and table (§4.2)", () => {
  const withMatrix = (extra: Record<string, unknown>) =>
    tweak((form) =>
      form.sections[1].fields.push({
        id: "fls",
        label: "Field level security",
        type: "matrix",
        rows: [{ id: "Discount__c", label: "Discount" }],
        cols: [{ id: "SalesOps", label: "Sales Ops" }],
        ...extra,
      }),
    );

  it("requires cellOptions for a select cell", () => {
    firstWith(withMatrix({ cellType: "single_select" }), "matrix_cell_options_required");
  });

  it("rejects cellOptions on a cell type that takes none", () => {
    firstWith(
      withMatrix({
        cellType: "number",
        cellOptions: [{ value: 1, label: "One" }],
      }),
      "matrix_cell_options_forbidden",
    );
  });

  it("rejects a constraint naming a row the matrix does not declare", () => {
    const diagnostic = firstWith(
      withMatrix({
        cellType: "single_select",
        cellOptions: [{ value: "R", label: "Read" }],
        constraints: [{ row: "Margin__c", col: "SalesOps", readOnly: true }],
      }),
      "matrix_constraint_unknown_member",
    );
    expect(diagnostic.message).toContain('"Discount__c"');
  });

  it("rejects a constraint allowing a value the grid cannot render", () => {
    firstWith(
      withMatrix({
        cellType: "single_select",
        cellOptions: [{ value: "R", label: "Read" }],
        constraints: [{ row: "Discount__c", col: "SalesOps", allowed: ["RW"] }],
      }),
      "matrix_constraint_unknown_value",
    );
  });

  it("rejects a constraint that says nothing", () => {
    firstWith(
      withMatrix({
        cellType: "single_select",
        cellOptions: [{ value: "R", label: "Read" }],
        constraints: [{ row: "Discount__c", col: "SalesOps" }],
      }),
      "matrix_constraint_empty",
    );
  });

  it("warns when cycle is asked for above four options", () => {
    const diagnostic = firstWith(
      withMatrix({
        cellType: "single_select",
        render: "cycle",
        cellOptions: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
          { value: "d", label: "D" },
          { value: "e", label: "E" },
        ],
      }),
      "matrix_cycle_option_count",
    );
    expect(diagnostic.message).toContain("paint");
  });

  it("rejects a container as a table column", () => {
    const diagnostic = firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "ledger",
          label: "Assumptions",
          type: "table",
          columns: [
            {
              id: "nested",
              label: "Nested",
              type: "repeatable",
              fields: [{ id: "inner", label: "Inner", type: "short_text" }],
            },
          ],
          rows: [{ id: "r_1", label: "One" }],
        }),
      ),
      "column_type_not_allowed",
    );
    expect(diagnostic.message).toContain("columns+data");
  });
});

/* -------------------------------------------------------------------------- */
/* prefill                                                                    */
/* -------------------------------------------------------------------------- */

describe("prefill (§4.7)", () => {
  it("rejects a prefill path that does not resolve", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.prefill.regoin = { value: "eu", source: "inferred" })),
      "unresolved_path",
    );
    expect(diagnostic.location).toBe('prefill["regoin"]');
  });

  it("rejects an ordinal prefill path", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push({
        id: "ledger",
        label: "Assumptions",
        type: "table",
        columns: [
          {
            id: "verdict",
            label: "Verdict",
            type: "single_select",
            options: [{ value: "ok", label: "OK" }],
          },
        ],
        rows: [{ id: "r_1", label: "One" }],
      });
      f.prefill["ledger[0].verdict"] = { value: "ok", source: "existing" };
    });
    firstWith(form, "ordinal_path");
  });

  it("rejects prefilling a read-only field", () => {
    const form = tweak((f) => {
      f.sections[1].fields.push({
        id: "plan",
        type: "info",
        markdown: "## Plan",
      });
      f.prefill.plan = { value: "anything", source: "inferred" };
    });
    firstWith(form, "prefill_target_read_only");
  });

  it("rejects a prefilled value the field cannot hold", () => {
    const diagnostic = firstWith(
      tweak((form) => (form.prefill.env = { value: "staging", source: "inferred" })),
      "prefill_value_not_an_option",
    );
    expect(diagnostic.message).toContain("skipOptions");
  });

  it("accepts a prefilled skipOption value — defer is an ordinary option", () => {
    expect(
      validateForm(
        tweak((form) => (form.prefill.env = { value: "you_decide", source: "inferred" })),
      ).ok,
    ).toBe(true);
  });

  it("rejects an array for a single-value field", () => {
    firstWith(
      tweak((form) => (form.prefill.env = { value: ["sandbox"], source: "inferred" })),
      "prefill_value_not_an_option",
    );
  });

  it("requires a value on a prefill entry", () => {
    expect(codes(tweak((form) => (form.prefill.env = { source: "inferred" })))).toContain(
      "malformed",
    );
  });

  it("warns when confidence rides on a value that was not inferred", () => {
    const diagnostic = firstWith(
      tweak(
        (form) =>
          (form.prefill.env = {
            value: "sandbox",
            source: "user",
            confidence: "high",
          }),
      ),
      "malformed",
    );
    expect(diagnostic.severity).toBe("warning");
  });

  it("warns about a form that prefills nothing", () => {
    const diagnostic = firstWith(
      tweak((form) => {
        form.prefill = {};
      }),
      "no_prefill",
    );
    expect(diagnostic.message).toContain("shouldn't exist");
  });
});

/* -------------------------------------------------------------------------- */
/* sections and smells                                                        */
/* -------------------------------------------------------------------------- */

describe("sections and smells (§4.8, §2)", () => {
  it("warns about a section with exactly one field", () => {
    const diagnostic = firstWith(
      tweak((form) => form.sections[1].fields.pop()),
      "section_single_field",
    );
    expect(diagnostic.location).toBe('sections[1] "timing"');
  });

  it("rejects a section with no fields at all", () => {
    expect(codes(tweak((form) => (form.sections[1].fields = [])))).toContain("malformed");
  });

  it("warns past the soft limit of seven fields", () => {
    const diagnostic = firstWith(
      tweak((form) => {
        for (let index = 0; index < 7; index += 1) {
          form.sections[0].fields.push({
            id: `extra${index}`,
            label: `Extra ${index}`,
            type: "short_text",
          });
        }
      }),
      "section_over_soft_limit",
    );
    expect(diagnostic.message).toContain("table");
  });

  it("warns about a form that is mostly prose", () => {
    const diagnostic = firstWith(
      tweak((form) => {
        form.sections[0].fields = [
          { id: "why", label: "Why", type: "long_text" },
          { id: "how", label: "How", type: "long_text" },
        ];
        form.sections[1].fields = [
          { id: "what", label: "What", type: "long_text" },
          { id: "env", label: "Environment", type: "short_text" },
        ];
        form.prefill = { env: { value: "sandbox", source: "inferred" } };
      }),
      "prose_heavy",
    );
    expect(diagnostic.message).toContain("should have been a conversation");
  });

  it("warns when a render hint does not fit the option count", () => {
    const diagnostic = firstWith(
      tweak((form) => {
        form.sections[0].fields[0].options = Array.from({ length: 6 }, (_, index) => ({
          value: `v${index}`,
          label: `Option ${index}`,
        }));
      }),
      "render_hint_option_count",
    );
    expect(diagnostic.message).toContain("segmented");
  });

  it("rejects a number range with nothing in it", () => {
    const diagnostic = firstWith(
      tweak((form) =>
        form.sections[1].fields.push({
          id: "batch",
          label: "Batch",
          type: "number",
          min: 10,
          max: 5,
        }),
      ),
      "malformed",
    );
    expect(diagnostic.message).toContain("never be satisfied");
  });
});

/* -------------------------------------------------------------------------- */
/* answers                                                                    */
/* -------------------------------------------------------------------------- */

describe("validateAnswers (§4.3)", () => {
  const form = validateForm(kitchenSink()).form as Form;

  it("accepts a path-keyed map of answered and empty entries", () => {
    const result = validateAnswers(
      {
        region: { state: "answered", value: "eu" },
        "ledger[r_7f3a].verdict": {
          state: "answered",
          value: "lets_talk",
          note: "depends on Legal",
        },
        notes: { state: "empty" },
        "fls[Discount__c][SalesOps]": { state: "answered", value: "RW" },
      },
      form,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Form accepted — no problems found.");
  });

  it("rejects a third answer state — defer is an option, not a state", () => {
    const result = validateAnswers({ region: { state: "deferred" } }, form);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("unknown_answer_state");
    expect(result.errors[0]?.message).toContain("ordinary agent-defined option");
  });

  it("rejects a value on an empty answer", () => {
    const result = validateAnswers({ region: { state: "empty", value: "eu" } }, form);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("not rendered = empty");
  });

  it("rejects an answered entry with no value", () => {
    expect(validateAnswers({ region: { state: "answered" } }, form).ok).toBe(false);
  });

  it("rejects an answer keyed by an ordinal row", () => {
    const result = validateAnswers({ "ledger[1].verdict": { state: "empty" } }, form);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("ordinal_path");
  });

  it("checks keys parse even with no form to resolve against", () => {
    expect(validateAnswers({ "ledger[*].verdict": { state: "empty" } }).ok).toBe(false);
  });
});
