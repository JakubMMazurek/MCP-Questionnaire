/**
 * The agent-facing rendering of the answers (§7.2, §4.1).
 *
 * What is worth pinning here is not the punctuation. It is the three claims the
 * agent acts on: that every question comes back INCLUDING the blank ones
 * (§4.6 — an empty answer is an answer), that a value arrives with both the
 * label the user saw and the machine value the agent branches on (§4.1), and
 * that the report reads in the order the form was filled rather than in
 * whatever order the store happened to hold.
 */

import { describe, expect, it } from "vitest";
import { assumptionLedger, elicitation } from "./__fixtures__/archetypes.js";
import { reportAnswers } from "./report.js";
import type { Answers, Form } from "./types.js";

const form = elicitation as unknown as Form;

describe("reportAnswers", () => {
  it("names the label the user saw AND the value the agent declared", () => {
    const answers: Answers = {
      scope: { state: "answered", value: "accounts_contacts" },
    };
    const report = reportAnswers(form, answers);
    expect(report.text).toContain('Scope <scope>: + Contacts ["accounts_contacts"]');
    expect(report.answered).toBe(1);
  });

  it("counts and prints the empty answers, because they are answers (§4.6)", () => {
    const answers: Answers = {
      scope: { state: "answered", value: "everything" },
      environment: { state: "empty" },
      cutover: { state: "empty" },
    };
    const report = reportAnswers(form, answers);
    expect(report.answered).toBe(1);
    expect(report.empty).toBe(2);
    expect(report.text).toContain("1 of 3 answered, 2 left empty.");
    expect(report.text).toContain("Environment <environment>: (empty)");
  });

  it("marks a skip option as the skip it is (§4.3)", () => {
    const report = reportAnswers(form, {
      environment: { state: "answered", value: "claude_decides" },
    });
    expect(report.text).toContain("You decide (skipped)");
  });

  it("resolves a date preset to its own label", () => {
    const report = reportAnswers(form, {
      cutover: { state: "answered", value: "2026-09-30" },
    });
    expect(report.text).toContain("End of Q3");
  });

  it("prints a bare number as itself, with no redundant machine value", () => {
    const report = reportAnswers(form, { tradeoff: { state: "answered", value: 7 } });
    expect(report.text).toContain("Speed ↔ thoroughness <tradeoff>: 7");
    expect(report.text).not.toContain("[7]");
  });

  it("carries a note on its own line, attributed to its path (§4.4)", () => {
    const report = reportAnswers(form, {
      scope: { state: "answered", value: "everything", note: "contacts are messy" },
    });
    expect(report.notes).toBe(1);
    expect(report.text).toContain("note: contacts are messy");
    expect(report.text).toContain("1 with a note");
  });

  it("reads in document order, not store order", () => {
    const report = reportAnswers(form, {
      cutover: { state: "answered", value: "2026-09-30" },
      scope: { state: "answered", value: "everything" },
      tradeoff: { state: "answered", value: 3 },
    });
    const at = (needle: string) => report.text.indexOf(needle);
    expect(at("<scope>")).toBeLessThan(at("<tradeoff>"));
    expect(at("<tradeoff>")).toBeLessThan(at("<cutover>"));
  });

  it("names a table cell by its row and column, not by its path (§4.5)", () => {
    const ledger = assumptionLedger as unknown as Form;
    const report = reportAnswers(ledger, {
      "assumptions[r_eu][verdict]": { state: "answered", value: "fix" },
    });
    // The label side of the line has to be readable to a human; the path is
    // there so the agent can address the same cell back.
    expect(report.text).toContain("<assumptions[r_eu][verdict]>");
    expect(report.lines[0]?.label).not.toBe("assumptions[r_eu][verdict]");
  });

  it("prints a path the form no longer declares rather than dropping it", () => {
    const report = reportAnswers(form, { gone: { state: "answered", value: "x" } });
    expect(report.text).toContain("gone <gone>: x");
  });

  it("says so when nothing has been answered at all", () => {
    const report = reportAnswers(form, {});
    expect(report.text).toBe("0 of 0 answered.");
    expect(report.lines).toEqual([]);
  });
});
