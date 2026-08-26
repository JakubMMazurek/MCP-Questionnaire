import { describe, expect, it } from "vitest";
import { canonicalPath, formatPath, hasOrdinalStep, parsePath } from "./paths.js";

function parsed(source: string) {
  const result = parsePath(source);
  if (!result.ok) throw new Error(`expected "${source}" to parse: ${result.error.message}`);
  return result.path;
}

function failure(source: string) {
  const result = parsePath(source);
  if (result.ok) throw new Error(`expected "${source}" to be rejected`);
  return result.error;
}

describe("parsePath — the §4.5 grammar", () => {
  it.each([
    "region",
    "fls[Discount__c][SalesOps]",
    "stakeholders[r_7f3a].owner",
    "$self.detail",
    "$parent.owner",
    "ledger.verdict",
    "a[b].c[d].e",
    "$self",
    "team[r_1][r_2].note",
    "external[Account.Name]",
  ])("round-trips %s", (source) => {
    expect(formatPath(parsed(source))).toBe(source);
  });

  it("keeps the head and the steps apart", () => {
    const path = parsed("stakeholders[r_7f3a].owner");
    expect(path.head).toEqual({ kind: "id", id: "stakeholders" });
    expect(path.steps).toEqual([
      { id: "r_7f3a", syntax: "bracket", ordinal: false },
      { id: "owner", syntax: "dot", ordinal: false },
    ]);
  });

  it("reads $self and $parent as markers, not ids", () => {
    expect(parsed("$self.detail").head).toEqual({ kind: "self" });
    expect(parsed("$parent.owner").head).toEqual({ kind: "parent" });
  });

  it("normalises bracket and dot syntax to one canonical key", () => {
    expect(canonicalPath(parsed("ledger.verdict"))).toBe("ledger[verdict]");
    expect(canonicalPath(parsed("ledger[verdict]"))).toBe("ledger[verdict]");
  });

  it("flags ordinal steps without rejecting them — the resolver teaches", () => {
    expect(hasOrdinalStep(parsed("stakeholders[2].owner"))).toBe(true);
    expect(parsed("stakeholders[2].owner").steps[0]?.ordinal).toBe(true);
    expect(hasOrdinalStep(parsed("stakeholders[r_2].owner"))).toBe(false);
  });
});

describe("parsePath — rejections teach", () => {
  it("rejects an empty path", () => {
    expect(failure("").message).toContain("may not be empty");
  });

  it("rejects an unclosed bracket, naming the column", () => {
    const error = failure("fls[Discount__c");
    expect(error.message).toContain('Missing "]"');
    expect(error.message).toContain("fls[Discount__c][SalesOps]");
    expect(error.column).toBe(16);
  });

  it("rejects an empty bracket", () => {
    expect(failure("fls[]").message).toContain('Nothing usable inside "[…]"');
  });

  it("rejects a trailing dot", () => {
    expect(failure("stakeholders.").message).toContain('Trailing or empty "."');
  });

  it("rejects JSONPath habits with a pointer at the grammar", () => {
    const error = failure("stakeholders[*].owner");
    expect(error.message).toContain("no wildcards");
    expect(error.message).toContain("segment");
  });

  it("rejects a filter expression", () => {
    expect(failure("fls[?(@.id=='x')]").message).toContain("no wildcards");
  });

  it("rejects an unknown $ marker", () => {
    const error = failure("$row.owner");
    expect(error.message).toContain('Unknown path marker "$row"');
    expect(error.message).toContain("$self");
  });

  it("rejects a marker in a step position", () => {
    expect(failure("stakeholders.$self").message).toContain("may only start a path");
  });

  it("rejects surrounding whitespace rather than silently trimming", () => {
    expect(failure(" region ").message).toContain("whitespace");
  });
});
