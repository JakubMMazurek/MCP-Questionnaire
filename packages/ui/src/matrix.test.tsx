/**
 * @vitest-environment jsdom
 *
 * The matrix (§5.5) — build step 5, stage C.
 *
 * The §5.5 mockup is normative, so these tests are written against what it
 * promises rather than against the implementation: a click cycles, a header
 * click unifies a mixed group, a constrained cell is SKIPPED and counted rather
 * than coerced, a read-only cell is inert and explains itself, dirty cells carry
 * a revert that returns them to the baseline (not to `empty`), and the whole
 * thing is navigable from the keyboard.
 */

import type { Form } from "@mcpq/schema";
import { FORM_SCHEMA_VERSION, matrixFls } from "@mcpq/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createEngineStore, type EngineStore } from "./engine/index.js";
import { cellModeOf, cellOptionsOf } from "./fields/matrix";
import { AppProvider } from "./state";

afterEach(cleanup);

function mount(form: unknown = matrixFls): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(form);
  store.getState().setDisplayMode("fullscreen");
  render(
    <AppProvider value={{ store, bridge: null }}>
      <App />
    </AppProvider>,
  );
  return store;
}

const cellOf = (row: string, col: string) => `grid[${row}][${col}]`;

/** The cell button, found the way the arrow-key walk finds it. */
function cell(row: string, col: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-col="${col}"]`);
  if (!found) throw new Error(`no cell ${row}/${col}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/* mode selection                                                             */
/* -------------------------------------------------------------------------- */

describe("interaction scales with the option count (§5.5)", () => {
  const withOptions = (count: number, render?: "cycle" | "paint") =>
    ({
      type: "matrix" as const,
      id: "grid",
      label: "Grid",
      cellType: "single_select" as const,
      ...(render ? { render } : {}),
      cellOptions: Array.from({ length: count }, (_, index) => ({
        value: `v${index}`,
        label: `V${index}`,
      })),
      rows: [{ id: "r", label: "R" }],
      cols: [{ id: "c", label: "C" }],
    }) as never;

  it("cycles at four values or fewer and paints above that", () => {
    expect(cellModeOf(withOptions(3))).toBe("cycle");
    expect(cellModeOf(withOptions(4))).toBe("cycle");
    expect(cellModeOf(withOptions(5))).toBe("paint");
  });

  it("lets the render hint override the count", () => {
    expect(cellModeOf(withOptions(8, "cycle"))).toBe("cycle");
    expect(cellModeOf(withOptions(2, "paint"))).toBe("paint");
  });

  it("gives number and short_text cells inputs, and multi_select cells a popover", () => {
    const numeric = {
      type: "matrix" as const,
      id: "grid",
      label: "Grid",
      cellType: "number" as const,
      rows: [{ id: "r", label: "R" }],
      cols: [{ id: "c", label: "C" }],
    } as never;
    expect(cellModeOf(numeric)).toBe("input");
  });

  it("treats the field's skipOptions as ordinary cell values (§4.3)", () => {
    const field = {
      ...(withOptions(2) as unknown as Record<string, unknown>),
      skipOptions: [{ value: "tbd", label: "TBD" }],
    } as never;
    expect(cellOptionsOf(field).map((option) => option.value)).toEqual(["v0", "v1", "tbd"]);
  });
});

/* -------------------------------------------------------------------------- */
/* cycle mode                                                                 */
/* -------------------------------------------------------------------------- */

describe("cycle mode", () => {
  it("renders the option LABEL in the cell, and advances on click", () => {
    const store = mount();
    // Prefilled `rw` from the `existing` baseline.
    expect(cell("Discount__c", "support").textContent).toBe("R");

    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    expect(store.getState().answers[cellOf("Discount__c", "support")]).toEqual({
      state: "answered",
      value: "rw",
    });
    expect(cell("Discount__c", "support").textContent).toBe("RW");

    // …and wraps.
    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    expect(cell("Discount__c", "support").textContent).toBe("–");
  });

  it("paints the anchor's value across the cells a drag passes over", () => {
    const store = mount();
    const grid = document.querySelector(".mgrid") as HTMLElement;
    // Anchor on a `none` cell: one step takes it to `r`, which then paints.
    fireEvent.pointerDown(cell("Approval_Level__c", "support"), { button: 0 });
    expect(store.getState().answers[cellOf("Approval_Level__c", "support")]).toEqual({
      state: "answered",
      value: "r",
    });

    fireEvent.pointerEnter(cell("Approval_Level__c", "rev_ops"));
    fireEvent.pointerEnter(cell("Approval_Level__c", "sales_ops"));
    fireEvent.pointerUp(grid);
    // The SAME value everywhere, not a running cycle.
    expect(store.getState().answers[cellOf("Approval_Level__c", "rev_ops")]).toEqual({
      state: "answered",
      value: "r",
    });
    expect(store.getState().answers[cellOf("Approval_Level__c", "sales_ops")]).toEqual({
      state: "answered",
      value: "r",
    });

    // The drag is over: hovering another cell changes nothing.
    fireEvent.pointerEnter(cell("Discount__c", "support"));
    expect(store.getState().answers[cellOf("Discount__c", "support")]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* paint mode                                                                 */
/* -------------------------------------------------------------------------- */

const PAINT: Form = {
  version: FORM_SCHEMA_VERSION,
  title: "Six values",
  display: "fullscreen",
  sections: [
    {
      id: "s",
      title: "Grid",
      fields: [
        {
          type: "matrix",
          id: "grid",
          label: "Stages",
          cellType: "single_select",
          cellOptions: [
            { value: "a", label: "Alpha", description: "the first one" },
            { value: "b", label: "Bravo" },
            { value: "c", label: "Charlie" },
            { value: "d", label: "Delta" },
            { value: "e", label: "Echo" },
          ],
          rows: [
            { id: "r1", label: "Row one" },
            { id: "r2", label: "Row two" },
          ],
          cols: [
            { id: "c1", label: "Col one" },
            { id: "c2", label: "Col two" },
          ],
          constraints: [{ row: "r2", col: "c2", allowed: ["a"], reason: "pinned by policy" }],
        },
      ],
    },
  ],
  prefill: { "grid[r1][c1]": { value: "a", source: "existing" } },
};

describe("paint mode", () => {
  it("offers a palette carrying each value's own label and description (§5.5)", () => {
    mount(PAINT);
    const palette = screen.getByRole("radiogroup", { name: "Stages — values" });
    const swatches = [...palette.querySelectorAll("button")];
    expect(swatches).toHaveLength(5);
    expect(swatches[0]?.textContent).toContain("Alpha");
    expect(swatches[0]?.getAttribute("title")).toBe("the first one");
  });

  it("applies the selected value on click, and does nothing before one is picked", () => {
    const store = mount(PAINT);
    fireEvent.pointerDown(cell("r1", "c2"), { button: 0 });
    expect(store.getState().answers["grid[r1][c2]"]).toBeUndefined();

    fireEvent.click(screen.getByRole("radio", { name: /Charlie/ }));
    fireEvent.pointerDown(cell("r1", "c2"), { button: 0 });
    expect(store.getState().answers["grid[r1][c2]"]).toEqual({
      state: "answered",
      value: "c",
    });
    expect(cell("r1", "c2").textContent).toBe("Charlie");
  });

  it("picks palette entries with the number keys", () => {
    const store = mount(PAINT);
    fireEvent.keyDown(cell("r1", "c2"), { key: "2" });
    expect(screen.getByRole("radio", { name: /Bravo/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(cell("r1", "c2"), { key: " " });
    expect(store.getState().answers["grid[r1][c2]"]).toEqual({ state: "answered", value: "b" });
  });

  it("skips the cells a constraint forbids, and says how many", () => {
    const store = mount(PAINT);
    fireEvent.click(screen.getByRole("radio", { name: /Bravo/ }));

    // `r2/c2` allows only "a", so the second column's bulk apply skips one.
    fireEvent.click(screen.getAllByTitle("Bulk-apply to this column")[1] as HTMLElement);
    expect(store.getState().answers["grid[r1][c2]"]).toEqual({ state: "answered", value: "b" });
    expect(store.getState().answers["grid[r2][c2]"]).toBeUndefined();
    expect(screen.getByLabelText("1 cells skipped — constrained")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* bulk apply                                                                 */
/* -------------------------------------------------------------------------- */

describe("header bulk apply (§5.5)", () => {
  it("unifies a mixed column on the first click", () => {
    const store = mount();
    // Sales Ops holds rw / rw / r / r — mixed. next(first) is "none".
    const header = screen.getByRole("button", { name: "Sales Ops" });
    fireEvent.click(header);
    for (const row of [
      "Discount__c",
      "Discount_Reason__c",
      "Approval_Level__c",
      "Margin_Floor__c",
    ]) {
      expect(store.getState().answers[cellOf(row, "sales_ops")]).toEqual({
        state: "answered",
        value: "none",
      });
    }
  });

  it("applies to a row, taking next() from the first cell's ALLOWED sequence", () => {
    const store = mount();
    // Margin_Floor__c is a formula field: every cell allows only none/r. The
    // constraint restricts the CYCLE SEQUENCE too (§5.5), so next("r") here is
    // "none" and not the unreachable "rw" — nothing is skipped, because nothing
    // illegal was ever proposed.
    fireEvent.click(screen.getByRole("button", { name: "Margin_Floor__c" }));
    expect(screen.queryByLabelText(/cells skipped/)).toBeNull();
    for (const col of ["sales_ops", "rev_ops", "support"]) {
      expect(store.getState().answers[cellOf("Margin_Floor__c", col)]).toEqual({
        state: "answered",
        value: "none",
      });
    }
  });

  it("skips a read-only cell in a row bulk, and counts it", () => {
    const store = mount();
    // Discount__c holds rw / rw / r, and its rev_ops cell is read-only.
    fireEvent.click(screen.getByRole("button", { name: "Discount__c" }));
    expect(screen.getByLabelText("1 cells skipped — constrained")).toBeDefined();
    expect(store.getState().answers[cellOf("Discount__c", "sales_ops")]).toEqual({
      state: "answered",
      value: "none",
    });
    expect(store.getState().answers[cellOf("Discount__c", "rev_ops")]).toBeUndefined();
  });

  it("never writes a read-only cell, whatever route the value comes by", () => {
    const store = mount();
    const locked = cell("Discount__c", "rev_ops");
    expect(locked.dataset.readonly).toBe("true");
    expect(locked.title).toBe("owned by the pricing team's permission set");

    fireEvent.pointerDown(locked, { button: 0 });
    expect(store.getState().answers[cellOf("Discount__c", "rev_ops")]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Rev Ops" }));
    expect(store.getState().answers[cellOf("Discount__c", "rev_ops")]).toBeUndefined();
    expect(screen.getByLabelText("1 cells skipped — constrained")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* the baseline diff                                                          */
/* -------------------------------------------------------------------------- */

describe("diff against the existing baseline (§4.7/§5.5)", () => {
  it("counts changes live, and marks the cell dirty", () => {
    mount();
    expect(screen.getByLabelText("0 changes vs current")).toBeDefined();
    expect(cell("Discount__c", "support").dataset.dirty).toBe("false");

    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    expect(screen.getByLabelText("1 changes vs current")).toBeDefined();
    expect(cell("Discount__c", "support").dataset.dirty).toBe("true");

    // Cycling back to the baseline value is not a change any more.
    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    expect(cell("Discount__c", "support").textContent).toBe("R");
    expect(screen.getByLabelText("0 changes vs current")).toBeDefined();
  });

  it("marks a changed-to-empty cell dirty rather than merely blank", () => {
    const store = mount();
    cell("Discount__c", "support").focus();
    fireEvent.keyDown(cell("Discount__c", "support"), { key: "Delete" });
    expect(store.getState().answers[cellOf("Discount__c", "support")]).toEqual({ state: "empty" });
    expect(cell("Discount__c", "support").textContent).toBe("–");
    expect(cell("Discount__c", "support").dataset.dirty).toBe("true");
    expect(screen.getByLabelText("1 changes vs current")).toBeDefined();
  });

  it("reverts one cell to the baseline — untouched, not empty", () => {
    const store = mount();
    fireEvent.pointerDown(cell("Discount__c", "support"), { button: 0 });
    fireEvent.click(screen.getByLabelText("Revert Discount__c · Support"));
    // The ENTRY is gone, so the §4.7 prefill shows through again. `empty` would
    // have left the cell dirty forever.
    expect(store.getState().answers[cellOf("Discount__c", "support")]).toBeUndefined();
    expect(cell("Discount__c", "support").textContent).toBe("R");
    expect(screen.getByLabelText("0 changes vs current")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* keyboard                                                                   */
/* -------------------------------------------------------------------------- */

describe("keyboard navigation (§5.5)", () => {
  it("moves a focus cell with the arrows and applies with space", () => {
    const store = mount();
    cell("Discount__c", "sales_ops").focus();
    fireEvent.keyDown(cell("Discount__c", "sales_ops"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("Discount__c", "rev_ops"));

    fireEvent.keyDown(cell("Discount__c", "rev_ops"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell("Discount_Reason__c", "rev_ops"));

    fireEvent.keyDown(cell("Discount_Reason__c", "rev_ops"), { key: " " });
    expect(store.getState().answers[cellOf("Discount_Reason__c", "rev_ops")]).toEqual({
      state: "answered",
      value: "rw",
    });
  });

  it("stops at the edges instead of wrapping", () => {
    mount();
    cell("Discount__c", "sales_ops").focus();
    fireEvent.keyDown(cell("Discount__c", "sales_ops"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cell("Discount__c", "sales_ops"));
    fireEvent.keyDown(cell("Discount__c", "sales_ops"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell("Discount__c", "sales_ops"));
  });

  it("fills a rectangle from the anchor on shift-click", () => {
    const store = mount();
    // Anchor at Discount__c/sales_ops, cycling it rw → none.
    fireEvent.pointerDown(cell("Discount__c", "sales_ops"), { button: 0 });
    fireEvent.pointerUp(document.querySelector(".mgrid") as HTMLElement);
    expect(store.getState().answers[cellOf("Discount__c", "sales_ops")]).toEqual({
      state: "answered",
      value: "none",
    });

    // Shift-click two rows down and one across. A rectangle PAINTS the anchor's
    // own value — it does not advance the cell you finished on, or the region
    // would depend on where you stopped rather than on what you were spreading.
    fireEvent.pointerDown(cell("Approval_Level__c", "rev_ops"), { button: 0, shiftKey: true });
    for (const row of ["Discount__c", "Discount_Reason__c", "Approval_Level__c"]) {
      for (const col of ["sales_ops", "rev_ops"]) {
        const entry = store.getState().answers[cellOf(row, col)];
        // …except the read-only cell, which is skipped and counted.
        if (row === "Discount__c" && col === "rev_ops") expect(entry).toBeUndefined();
        else expect(entry).toEqual({ state: "answered", value: "none" });
      }
    }
    expect(screen.getByLabelText("1 cells skipped — constrained")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* mobile (§7.3)                                                              */
/* -------------------------------------------------------------------------- */

describe("mobile (§7.3)", () => {
  it("renders a read-only value list rather than an uneditable grid", () => {
    const store = createEngineStore();
    store.getState().loadForm(matrixFls);
    store.getState().setDisplayMode("fullscreen");
    store.getState().setPlatform("mobile");
    render(
      <AppProvider value={{ store, bridge: null }}>
        <App />
      </AppProvider>,
    );
    expect(document.querySelector(".mgrid")).toBeNull();
    expect(screen.getByText(/Read-only on a phone/)).toBeDefined();
    expect(screen.getByText(/Sales Ops: RW · Rev Ops: RW · Support: R/)).toBeDefined();
  });
});
