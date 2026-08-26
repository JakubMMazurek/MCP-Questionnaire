/**
 * @vitest-environment jsdom
 *
 * The rest of the §4.2 field types (build step 5, stage B).
 *
 * These are behaviour tests, not snapshots: what is worth pinning down is the
 * part the spec asserts and prose cannot enforce — that a `list` never opens a
 * portal-less dropdown in an inline card (§7.3), that an out-of-range number
 * gates submit while an unanswered required field does not (§6.3), that
 * over-allocating blocks and under-allocating submits (§4.2), that a repeatable
 * row is addressed by a minted id and never an ordinal (§4.5), and that a small
 * form renders for real inline instead of being a card that says "open me".
 */

import type { Form } from "@gather/schema";
import { convergence, elicitation, FORM_SCHEMA_VERSION } from "@gather/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App, fitsInline } from "./App";
import { createEngineStore, type EngineStore } from "./engine/index.js";
import { rankOrder } from "./fields/rank";
import { AppProvider } from "./state";

afterEach(cleanup);

function mount(form: unknown, mode: "inline" | "fullscreen" = "fullscreen"): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(form);
  store.getState().setDisplayMode(mode);
  render(
    <AppProvider value={{ store, bridge: null }}>
      <App />
    </AppProvider>,
  );
  return store;
}

/* -------------------------------------------------------------------------- */
/* §5.2 elicitation — the inline card that actually elicits                   */
/* -------------------------------------------------------------------------- */

describe("the inline elicitation card (§5.2/§7.3)", () => {
  it("renders a small form's fields inline rather than a summary card", () => {
    mount(elicitation, "inline");
    expect(screen.getByText("Quick setup for the data migration")).toBeDefined();
    expect(screen.queryByText("Review in fullscreen")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Scope" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Speed ↔ thoroughness" })).toBeDefined();
    expect(screen.getByText("Looks right — go")).toBeDefined();
  });

  it("keeps the summary card for anything dense (§7.3)", () => {
    // A table has no honest inline rendering: it cannot fit its own height.
    expect(fitsInline(convergence as unknown as Form)).toBe(false);
    expect(fitsInline(elicitation as unknown as Form)).toBe(true);
    const many: Form = {
      version: FORM_SCHEMA_VERSION,
      title: "Nine questions",
      sections: [
        {
          id: "s",
          title: "s",
          fields: Array.from({ length: 9 }, (_, index) => ({
            type: "short_text" as const,
            id: `q${index}`,
            label: `Q${index}`,
          })),
        },
      ],
    };
    expect(fitsInline(many)).toBe(false);
  });

  it("offers at most two actions inline, and always the chat escape hatch", () => {
    mount(elicitation, "inline");
    const buttons = [...document.querySelectorAll(".bar button")];
    expect(buttons.length).toBeLessThanOrEqual(2);
    expect(screen.getByText("…or just tell me in chat")).toBeDefined();
  });

  it("reveals a follow-up field and narrows its options (§4.6 filter_options)", () => {
    const store = mount(elicitation, "inline");
    // `environment` is prefilled `sandbox`, so the follow-up is already shown.
    const sandbox = screen.getByRole("radiogroup", { name: "Which sandbox?" });
    expect([...sandbox.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "UAT",
      "Dev",
      "Staging",
    ]);

    act(() => {
      store.getState().setAnswer("scope", "everything");
    });
    const narrowed = screen.getByRole("radiogroup", { name: "Which sandbox?" });
    expect([...narrowed.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "UAT",
      "Staging",
    ]);

    act(() => {
      store.getState().setAnswer("environment", "production");
    });
    expect(screen.queryByRole("radiogroup", { name: "Which sandbox?" })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* date, slider                                                               */
/* -------------------------------------------------------------------------- */

describe("date and slider", () => {
  it("puts the named presets first and the picker beside them (§4.2)", () => {
    const store = mount(elicitation, "inline");
    const presets = screen.getByRole("radiogroup", { name: "Cutover — presets" });
    const labels = [...presets.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["End of Q3", "Next weekend", "TBD"]);

    const picker = screen.getByLabelText("Cutover") as HTMLInputElement;
    expect(picker.type).toBe("date");
    // Prefilled "2026-09-30" reads back into the picker AND lights the preset.
    expect(picker.value).toBe("2026-09-30");

    fireEvent.click(screen.getByText("Next weekend"));
    expect(store.getState().answers.cutover).toEqual({
      state: "answered",
      value: "2026-08-30",
    });
  });

  it("never feeds an agent-declared skip value to the date picker (§4.3)", () => {
    const store = mount(elicitation, "inline");
    fireEvent.click(screen.getByText("TBD"));
    expect(store.getState().answers.cutover).toEqual({ state: "answered", value: "tbd" });
    expect((screen.getByLabelText("Cutover") as HTMLInputElement).value).toBe("");
  });

  it("carries the tradeoff on the end labels, not the number (§5.2)", () => {
    const store = mount(elicitation, "inline");
    expect(screen.getByText("fast")).toBeDefined();
    expect(screen.getByText("exhaustive")).toBeDefined();
    const slider = screen.getByRole("slider", { name: "Speed ↔ thoroughness" });
    fireEvent.change(slider, { target: { value: "8" } });
    expect(store.getState().answers.tradeoff).toEqual({ state: "answered", value: 8 });
  });
});

/* -------------------------------------------------------------------------- */
/* §5.3 convergence — boolean toggle, searchable list, repeatable             */
/* -------------------------------------------------------------------------- */

describe("boolean toggle and the searchable list (§4.2/§7.3)", () => {
  it("renders a switch, and reveals the row's reason when it goes false", () => {
    const store = mount(convergence);
    const keep = screen.getByRole("switch", {
      name: "Self-serve onboarding flow — Keep",
    });
    expect(keep.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(keep);
    expect(store.getState().answers["candidates[r_selfserve][keep]"]).toEqual({
      state: "answered",
      value: false,
    });
    // The $self rule fires for this row only (§4.6). `r_docs` is prefilled
    // false, so its reason is already showing; `r_pricing` has no prefill and
    // an unanswered boolean is empty, on which every comparison op is false.
    expect(
      screen.getByRole("button", { name: "Self-serve onboarding flow — Why it died" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Usage-based pricing tier — Why it died" }),
    ).toBeNull();
  });

  it("opens the list in the top layer in fullscreen, and filters by label text", () => {
    const store = mount(convergence);
    fireEvent.click(screen.getByRole("switch", { name: "Docs overhaul — Keep" }));
    // `r_docs` is prefilled false, so one click makes it true; click again.
    fireEvent.click(screen.getByRole("switch", { name: "Docs overhaul — Keep" }));

    const trigger = screen.getByRole("button", { name: "Docs overhaul — Why it died" });
    fireEvent.click(trigger);
    // The option list lives in a <dialog> — the top layer escapes ancestor
    // overflow inside our own document, which is the only escape §7.3 allows.
    const dialog = document.querySelector("dialog.combo-dialog") as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    expect(dialog.hasAttribute("open")).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Search Docs overhaul/), {
      target: { value: "slow" },
    });
    const options = [...dialog.querySelectorAll(".combo-option")].map(
      (o) => o.querySelector(".tile-label")?.textContent,
    );
    expect(options).toEqual(["Too slow"]);

    fireEvent.click(screen.getByRole("option", { name: /Too slow/ }));
    expect(store.getState().answers["candidates[r_docs][why_killed]"]).toEqual({
      state: "answered",
      value: "too_slow",
    });
  });

  it("renders the list in flow inline — never a popover in a card (§7.3)", () => {
    const listForm: Form = {
      version: FORM_SCHEMA_VERSION,
      title: "Pick a region",
      display: "inline",
      sections: [
        {
          id: "s",
          title: "Region",
          fields: [
            {
              type: "single_select",
              id: "region",
              label: "Region",
              render: "list",
              options: [
                { value: "eu", label: "EU (Frankfurt)" },
                { value: "us", label: "US (Virginia)" },
              ],
            },
          ],
        },
      ],
      prefill: { region: { value: "eu", source: "inferred" } },
    };
    mount(listForm, "inline");
    fireEvent.click(screen.getByRole("button", { name: "Region" }));
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector(".combo-inline")).not.toBeNull();
    expect(screen.getByRole("option", { name: /US \(Virginia\)/ })).toBeDefined();
  });
});

describe("repeatable (§4.2/§4.5)", () => {
  it("adds and removes rows under client-minted ids, never ordinals", () => {
    const store = mount(convergence);
    fireEvent.click(screen.getByText("Add a candidate"));
    const rows = store.getState().rows.additions ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^r_[a-z0-9]{4}$/);

    const rowId = rows[0] as string;
    const idea = screen.getByLabelText("Add your own 1 — Candidate");
    fireEvent.change(idea, { target: { value: "Ship the CLI" } });
    expect(store.getState().answers[`additions[${rowId}][idea]`]).toEqual({
      state: "answered",
      value: "Ship the CLI",
    });

    // Removing the row takes its answers with it — nothing re-points.
    fireEvent.click(screen.getByLabelText("Remove Add your own 1"));
    expect(store.getState().rows.additions).toHaveLength(0);
    expect(store.getState().answers[`additions[${rowId}][idea]`]).toBeUndefined();
  });

  it("stops at the declared max", () => {
    const store = mount(convergence);
    const add = screen.getByText("Add a candidate") as HTMLButtonElement;
    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByText("Add a candidate"));
    expect(store.getState().rows.additions).toHaveLength(5);
    expect((screen.getByText("Add a candidate") as HTMLButtonElement).disabled).toBe(true);
    expect(add).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* number, text, multi_select, allocation, rank                               */
/* -------------------------------------------------------------------------- */

const MIXED: Form = {
  version: FORM_SCHEMA_VERSION,
  title: "Everything else",
  display: "fullscreen",
  submitLabel: "Send",
  sections: [
    {
      id: "numbers",
      title: "Numbers",
      fields: [
        {
          type: "number",
          id: "days",
          label: "Days of runway",
          min: 1,
          max: 30,
          step: 1,
          unit: "days",
          required: true,
        },
        {
          type: "long_text",
          id: "context",
          label: "Anything else",
          maxLength: 20,
        },
        {
          type: "multi_select",
          id: "risks",
          label: "Risks",
          render: "chips",
          options: [
            { value: "data", label: "Data loss" },
            { value: "downtime", label: "Downtime" },
            { value: "cost", label: "Cost" },
          ],
          skipOptions: [{ value: "none_known", label: "None known" }],
        },
        {
          type: "multi_select",
          id: "teams",
          label: "Teams",
          render: "checkboxes",
          options: [
            { value: "sales", label: "Sales" },
            { value: "support", label: "Support" },
          ],
        },
        {
          type: "date_range",
          id: "window",
          label: "Freeze window",
        },
      ],
    },
    {
      id: "split",
      title: "Split",
      fields: [
        {
          type: "allocation",
          id: "effort",
          label: "Effort",
          total: 100,
          unit: "%",
          members: [
            { id: "build", label: "Build" },
            { id: "test", label: "Test" },
          ],
        },
        {
          type: "rank",
          id: "order",
          label: "Priority",
          items: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
            { id: "c", label: "Gamma" },
          ],
        },
      ],
    },
  ],
  prefill: { days: { value: 14, source: "inferred", confidence: "high" } },
};

const submitButton = () => screen.getByText("Send") as HTMLButtonElement;

describe("number and text gate on format only (§6.3)", () => {
  it("does not gate on an unanswered required field", () => {
    mount(MIXED);
    expect(screen.getByText("Days of runway")).toBeDefined();
    expect(submitButton().disabled).toBe(false);
  });

  it("gates on a value the field's own bounds reject, and says so in place", () => {
    const store = mount(MIXED);
    fireEvent.change(screen.getByLabelText("Days of runway"), { target: { value: "45" } });
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("above the maximum of 30");
    // The gate names the offender and is the way back to it (§6.3).
    const gate = document.querySelector(".gate") as HTMLElement;
    expect(gate.textContent).toContain("Days of runway is above the maximum of 30");

    fireEvent.change(screen.getByLabelText("Days of runway"), { target: { value: "12" } });
    expect(submitButton().disabled).toBe(false);
    expect(store.getState().answers.days).toEqual({ state: "answered", value: 12 });
  });

  it("marks the section rail, so the error is findable", () => {
    mount(MIXED);
    fireEvent.change(screen.getByLabelText("Days of runway"), { target: { value: "0" } });
    const rail = screen.getByRole("navigation", { name: "Sections" });
    expect(rail.textContent).toContain("error");
  });

  it("shows the over-long text rather than truncating it", () => {
    const store = mount(MIXED);
    const long = "x".repeat(25);
    fireEvent.change(screen.getByLabelText("Anything else"), { target: { value: long } });
    expect((screen.getByLabelText("Anything else") as HTMLTextAreaElement).value).toBe(long);
    expect(submitButton().disabled).toBe(true);
    expect(store.getState().answers.context).toEqual({ state: "answered", value: long });
  });

  it("gates a date range that ends before it starts", () => {
    mount(MIXED);
    fireEvent.change(screen.getByLabelText("Freeze window — start"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(screen.getByLabelText("Freeze window — end"), {
      target: { value: "2026-09-01" },
    });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Freeze window — end"), {
      target: { value: "2026-09-20" },
    });
    expect(submitButton().disabled).toBe(false);
  });
});

describe("multi_select", () => {
  it("accumulates chips, and an empty set is `empty`, not `[]`", () => {
    const store = mount(MIXED);
    fireEvent.click(screen.getByRole("button", { name: "Data loss" }));
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(store.getState().answers.risks).toEqual({
      state: "answered",
      value: ["data", "cost"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Data loss" }));
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(store.getState().answers.risks).toEqual({ state: "empty" });
  });

  it("treats a skip option as exclusive (§4.3)", () => {
    const store = mount(MIXED);
    fireEvent.click(screen.getByRole("button", { name: "Data loss" }));
    fireEvent.click(screen.getByRole("button", { name: "None known" }));
    expect(store.getState().answers.risks).toEqual({
      state: "answered",
      value: ["none_known"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Downtime" }));
    expect(store.getState().answers.risks).toEqual({ state: "answered", value: ["downtime"] });
  });

  it("uses real inputs for checkboxes", () => {
    const store = mount(MIXED);
    fireEvent.click(screen.getByRole("checkbox", { name: /Support/ }));
    expect(store.getState().answers.teams).toEqual({ state: "answered", value: ["support"] });
  });
});

describe("allocation — the constraint is on the set (§4.2)", () => {
  it("counts down what is left to allocate", () => {
    mount(MIXED);
    expect(screen.getByLabelText("100 % of 100 % left to allocate")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Build"), { target: { value: "60" } });
    expect(screen.getByLabelText("40 % of 100 % left to allocate")).toBeDefined();
  });

  it("submits an under-allocation, and blocks an over-allocation", () => {
    const store = mount(MIXED);
    fireEvent.change(screen.getByLabelText("Build"), { target: { value: "30" } });
    // Under: partial submit is the norm; the agent sees the remainder (§5.6).
    expect(submitButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Test"), { target: { value: "90" } });
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByLabelText("20 % over the 100 % available")).toBeDefined();
    const gate = document.querySelector(".gate") as HTMLElement;
    expect(gate.textContent).toContain("allocates 120 % of 100 %");

    fireEvent.change(screen.getByLabelText("Test"), { target: { value: "70" } });
    expect(submitButton().disabled).toBe(false);
    // One path per member — what `sum` adds and a note can anchor to (§4.3).
    expect(store.getState().answers["effort[build]"]).toEqual({ state: "answered", value: 30 });
    expect(store.getState().answers["effort[test]"]).toEqual({ state: "answered", value: 70 });
  });
});

describe("rank — position is the value (§4.5)", () => {
  it("renders the declared order with a keyboard-reachable handle per item", () => {
    mount(MIXED);
    const list = screen.getByRole("list", { name: "Priority" });
    expect([...list.querySelectorAll(".rank-position")].map((n) => n.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    // dnd-kit's keyboard sensor drives the handle; it must be a real button.
    const handle = screen.getByRole("button", { name: "Reorder Alpha — currently 1" });
    expect(handle.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("stores an ordered id array, which is what re-renders the positions", () => {
    const store = mount(MIXED);
    act(() => {
      store.getState().setAnswer("order", ["c", "a", "b"]);
    });
    const list = screen.getByRole("list", { name: "Priority" });
    expect([...list.querySelectorAll(".tile-label")].map((n) => n.textContent)).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(screen.getByRole("button", { name: "Reorder Gamma — currently 1" })).toBeDefined();
  });

  it("survives an answer that names an unknown or missing item", () => {
    const field = {
      type: "rank" as const,
      id: "order",
      label: "Priority",
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "c", label: "Gamma" },
      ],
    };
    expect(rankOrder(field, ["c"])).toEqual(["c", "a", "b"]);
    expect(rankOrder(field, ["zzz", "b"])).toEqual(["b", "a", "c"]);
    expect(rankOrder(field, undefined)).toEqual(["a", "b", "c"]);
  });
});

describe("info blocks (§5.4)", () => {
  it("takes a note anchored to the block, and lives happily in a collapsed section", () => {
    const form: Form = {
      version: FORM_SCHEMA_VERSION,
      title: "Plan",
      display: "fullscreen",
      sections: [
        {
          id: "detail",
          title: "The detail",
          initially: "collapsed",
          fields: [
            { type: "info", id: "part1", label: "Phase 1", markdown: "**Week 1.** Dry run." },
          ],
        },
        {
          id: "verdict",
          title: "Verdict",
          fields: [
            {
              type: "single_select",
              id: "ok",
              label: "Approve?",
              render: "segmented",
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ],
            },
          ],
        },
      ],
      prefill: { ok: { value: "yes", source: "inferred" } },
    };
    const store = mount(form);
    expect(screen.queryByText("Phase 1")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand The detail"));
    expect(screen.getByText("Phase 1")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Add a note to Phase 1"));
    fireEvent.change(screen.getByPlaceholderText(/note for Claude/), {
      target: { value: "the third bit is off" },
    });
    expect(store.getState().answers.part1).toEqual({
      state: "empty",
      note: "the third bit is off",
    });
  });
});
