import { beforeAll, describe, expect, it } from "vitest";
import { kitchenSink } from "./__fixtures__/forms.js";
import { type ResolveResult, resolvePath } from "./resolve.js";
import type { Form } from "./types.js";
import { validateForm } from "./validate.js";

let form: Form;

beforeAll(() => {
  const result = validateForm(kitchenSink());
  if (!result.form) throw new Error(`fixture must be valid:\n${result.text}`);
  form = result.form;
});

function ok(path: string): Extract<ResolveResult, { ok: true }> {
  const result = resolvePath(form, path);
  if (!result.ok) throw new Error(`expected "${path}" to resolve: ${result.error.message}`);
  return result;
}

function bad(path: string) {
  const result = resolvePath(form, path);
  if (result.ok) throw new Error(`expected "${path}" to be rejected`);
  return result.error;
}

describe("resolvePath — what a path addresses", () => {
  it("resolves a top-level field", () => {
    const target = ok("region").target;
    expect(target.kind).toBe("field");
    expect(target.kind === "field" && target.field.id).toBe("region");
  });

  it("resolves a section, so a rule can show a whole section", () => {
    expect(ok("timing").target.kind).toBe("section");
  });

  it("resolves a table column — the whole column, across every row", () => {
    const target = ok("ledger.verdict").target;
    expect(target.kind).toBe("field");
    expect(target.kind === "field" && target.container?.id).toBe("ledger");
    expect(target.kind === "field" && target.rowId).toBeUndefined();
  });

  it("resolves one cell of a table by minted row id", () => {
    const target = ok("ledger[r_7f3a].verdict").target;
    expect(target.kind === "field" && target.rowId).toBe("r_7f3a");
    expect(target.kind === "field" && target.field.id).toBe("verdict");
  });

  it("resolves a repeatable sub-field, with and without a row", () => {
    expect(ok("stakeholders.owner").target.kind).toBe("field");
    const withRow = ok("stakeholders[r_1].owner").target;
    expect(withRow.kind === "field" && withRow.rowId).toBe("r_1");
  });

  it("resolves a matrix row and a matrix cell", () => {
    expect(ok("fls[Discount__c]").target.kind).toBe("matrix_row");
    const cell = ok("fls[Discount__c][SalesOps]").target;
    expect(cell.kind).toBe("matrix_cell");
    expect(cell.kind === "matrix_cell" && cell.col.id).toBe("SalesOps");
  });

  it("resolves rank items and allocation members by declared id", () => {
    expect(ok("priorities[data]").target.kind).toBe("rank_item");
    expect(ok("effort[migration]").target.kind).toBe("allocation_member");
  });

  it("resolves $self against every container when no scope is given", () => {
    const result = ok("$self.verdict");
    expect(result.target.kind === "field" && result.target.container?.id).toBe("ledger");
    expect(result.alsoResolvesIn).toEqual([]);
  });

  it("resolves $parent from a row to the container field", () => {
    const result = ok("$parent");
    expect(result.target.kind).toBe("field");
  });

  it("gives bracket and dot syntax the same canonical key", () => {
    expect(ok("ledger[verdict]").canonical).toBe(ok("ledger.verdict").canonical);
  });
});

describe("resolvePath — ordinals are rejected with a teaching error", () => {
  it("rejects an ordinal row of a table", () => {
    const error = bad("ledger[2].verdict");
    expect(error.code).toBe("ordinal_row");
    expect(error.message).toContain("by position");
    expect(error.message).toContain("r_7f3a");
    expect(error.message).toContain("§4.5");
  });

  it("rejects an ordinal row of a repeatable, and shows the shape to use", () => {
    const error = bad("stakeholders[2].owner");
    expect(error.code).toBe("ordinal_row");
    expect(error.message).toContain('"stakeholders[r_7f3a].owner"');
  });

  it("rejects an ordinal item of a rank field, because position is the value", () => {
    const error = bad("priorities[1]");
    expect(error.code).toBe("ordinal_row");
    expect(error.message).toContain("position IS the value");
  });

  it("rejects an ordinal column, which is declared once and never moves", () => {
    const error = bad("ledger[r_7f3a][0]");
    expect(error.code).toBe("ordinal_member");
    expect(error.message).toContain("declared id");
  });

  it("rejects an ordinal matrix row rather than guessing", () => {
    const error = bad("fls[0][SalesOps]");
    expect(error.code).toBe("ordinal_member");
    expect(error.message).toContain("fixed for the life of the view");
  });
});

describe("resolvePath — other failures name what is declared", () => {
  it("lists the declared ids when the root is unknown", () => {
    const error = bad("regoin");
    expect(error.code).toBe("unknown_root");
    expect(error.message).toContain('"region"');
    expect(error.message).toContain("section ids");
  });

  it("refuses to walk past a leaf field", () => {
    const error = bad("region.detail");
    expect(error.code).toBe("not_addressable");
    expect(error.message).toContain('type "single_select"');
  });

  it("names the declared columns when a matrix column is unknown", () => {
    const error = bad("fls[Discount__c][Marketing]");
    expect(error.code).toBe("unknown_member");
    expect(error.message).toContain('"SalesOps"');
  });

  it("says which containers were tried when $self resolves nowhere", () => {
    const error = bad("$self.nope");
    expect(error.code).toBe("self_out_of_scope");
    expect(error.message).toContain("Containers tried");
    expect(error.message).toContain("stakeholders");
    expect(error.message).toContain("ledger");
  });

  it("passes a parse failure straight through", () => {
    expect(bad("ledger[*].verdict").code).toBe("unparsable");
  });
});

describe("resolvePath — an explicit scope pins $self to one container", () => {
  it("resolves $self in the given container only", () => {
    const ledger = form.sections
      .flatMap((section) => section.fields)
      .find((field) => field.id === "ledger");
    if (ledger?.type !== "table") throw new Error("fixture changed");
    const result = resolvePath(form, "$self.verdict", {
      scope: { chain: [ledger], rowIds: ["r_91bc"] },
    });
    expect(result.ok && result.target.kind === "field" && result.target.rowId).toBe("r_91bc");
  });

  it("fails inside the wrong container instead of silently searching", () => {
    const stakeholders = form.sections
      .flatMap((section) => section.fields)
      .find((field) => field.id === "stakeholders");
    if (stakeholders?.type !== "repeatable") throw new Error("fixture changed");
    const result = resolvePath(form, "$self.verdict", {
      scope: { chain: [stakeholders] },
    });
    expect(result.ok).toBe(false);
  });
});
