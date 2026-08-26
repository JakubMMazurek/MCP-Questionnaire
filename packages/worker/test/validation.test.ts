/**
 * The §6.3 validation loop: the tool result teaches, and the teaching includes a
 * worked example.
 *
 * "Return the matching worked example alongside the errors — that makes
 * convergence work even with no skill and no guide call." So the assertion here
 * is not just "it errored": it is that the reply names the exact problem AND
 * carries a valid form of the closest shape, which is the difference between a
 * validator and a teacher.
 */

import { validateForm } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import { ALL_EXAMPLES, ARCHETYPES } from "../src/recipes.js";
import { closestArchetype } from "../src/worked-example.js";
import { connect, firstText } from "./harness.js";

describe("gather_decisions on a malformed schema", () => {
  it("returns the diagnostics AND a worked example", async () => {
    const { call, close } = await connect();
    const result = await call("gather_decisions", {
      form: { title: "nope", sections: [{ fields: [{ type: "slider_group", id: "x" }] }] },
    });
    await close();

    expect(result.isError).toBe(true);
    const body = firstText(result);

    // (a) names the exact location, (b) says what to do instead.
    expect(body).toContain("Form rejected");
    expect(body).toContain("sections[0]");

    // The worked example, and it is a REAL one — parse it back out and validate.
    expect(body).toContain("A worked example of the closest archetype");
    const json = body.slice(body.indexOf('{"version"'));
    expect(validateForm(JSON.parse(json)).ok).toBe(true);
  });

  it("names the unknown field type rather than shrugging", async () => {
    const { call, close } = await connect();
    const result = await call("gather_decisions", {
      form: {
        version: 1,
        title: "T",
        sections: [
          {
            id: "s",
            title: "S",
            fields: [
              { type: "slider_group", id: "x", label: "X" },
              { type: "boolean", id: "y", label: "Y" },
            ],
          },
        ],
      },
    });
    await close();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("slider_group");
  });

  it("teaches the §4.5 ordinal rule instead of silently re-pointing", async () => {
    const { call, close } = await connect();
    const result = await call("gather_decisions", {
      form: {
        version: 1,
        title: "T",
        sections: [
          {
            id: "s",
            title: "S",
            fields: [
              {
                type: "table",
                id: "stakeholders",
                label: "Stakeholders",
                columns: [
                  {
                    type: "single_select",
                    id: "owner",
                    label: "Owner",
                    options: [{ value: "a", label: "A" }],
                  },
                ],
                rows: [{ id: "r_1", label: "One" }],
              },
              { type: "boolean", id: "b", label: "B" },
            ],
          },
        ],
        rules: [
          {
            when: { field: "stakeholders[2].owner", op: "eq", value: "a" },
            then: { action: "show", targets: ["b"] },
          },
        ],
      },
    });
    await close();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/ordinal/i);
  });

  it("never returns the author's own schema back in the error", async () => {
    const secret = "Rollout targets the Kraken division only";
    const { call, close } = await connect();
    const result = await call("gather_decisions", {
      form: { title: secret, sections: "not-an-array" },
    });
    await close();
    // The diagnostics name paths and codes, not content. (The worked example is
    // ours, not theirs.)
    expect(firstText(result)).not.toContain(secret);
  });
});

describe("worked example selection", () => {
  it("sends a matrix author the matrix, a table author the ledger, else elicitation", () => {
    expect(closestArchetype({ sections: [{ fields: [{ type: "matrix", id: "m" }] }] })).toBe(
      "matrix",
    );
    expect(closestArchetype({ sections: [{ fields: [{ type: "table", id: "t" }] }] })).toBe(
      "ledger",
    );
    expect(closestArchetype({ sections: [{ fields: [{ type: "boolean", id: "b" }] }] })).toBe(
      "elicitation",
    );
    expect(closestArchetype({ nothing: "useful" })).toBe("elicitation");
  });

  it("reads structure when the input is too broken to have a usable type", () => {
    expect(closestArchetype({ fields: [{ cols: [], rows: [] }] })).toBe("matrix");
    expect(closestArchetype({ fields: [{ columns: [] }] })).toBe("ledger");
  });

  it("does not loop on a cyclic input", () => {
    const cyclic: Record<string, unknown> = { type: "table" };
    cyclic.self = cyclic;
    expect(closestArchetype(cyclic)).toBe("ledger");
  });
});

describe("the shipped worked examples", () => {
  it("all validate — an example that does not is worse than none", () => {
    // Two archetypes ship two examples: the ledger (the audited reference plus
    // its minimal floor) and convergence (the prune plus the chained rank form
    // it hands off to, §5.6).
    expect(ALL_EXAMPLES.length).toBe(ARCHETYPES.length + 2);
    for (const example of ALL_EXAMPLES) {
      const result = validateForm(example.form);
      expect(result.errors, example.title).toEqual([]);
      expect(result.ok, example.title).toBe(true);
    }
  });

  it("all prefill something — §4.7's own warning applies to us first", () => {
    for (const example of ALL_EXAMPLES) {
      expect(Object.keys(example.form.prefill ?? {}).length, example.title).toBeGreaterThan(0);
    }
  });
});
