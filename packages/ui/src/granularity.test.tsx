/**
 * @vitest-environment jsdom
 *
 * The §5.5/§8 performance requirement, as a test: "a click re-renders one cell,
 * not eight hundred". The mechanism is per-path selectors over a reconciled
 * effects object, so the honest way to test it is to subscribe with the very
 * hooks the cells use and count renders.
 */

import { assumptionLedger, matrixFls } from "@gather/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createEngineStore } from "./engine/index.js";
import {
  AppProvider,
  useDirty,
  useEffective,
  useFilteredOptions,
  useNote,
  useVisible,
} from "./state";

afterEach(cleanup);

type Counter = { renders: number };

/** Subscribes exactly the way a table cell does. */
function Cell({ path, counter }: { path: string; counter: Counter }) {
  useEffective(path);
  useVisible(path);
  useNote(path);
  useFilteredOptions(path);
  counter.renders += 1;
  return null;
}

/** Subscribes exactly the way a MATRIX cell does — the dirty mark included. */
function GridCell({ path, counter }: { path: string; counter: Counter }) {
  useEffective(path);
  useDirty(path);
  useVisible(path);
  counter.renders += 1;
  return null;
}

const verdict = (row: string) => `assumptions[${row}][verdict]`;
const correction = (row: string) => `assumptions[${row}][correction]`;

describe("selector granularity", () => {
  it("re-renders only the cells whose own path changed", () => {
    const store = createEngineStore();
    store.getState().loadForm(assumptionLedger);
    const counters: Record<string, Counter> = {
      eu: { renders: 0 },
      salesops: { renders: 0 },
      cutover: { renders: 0 },
    };

    render(
      <AppProvider value={{ store, bridge: null }}>
        <Cell path={verdict("r_eu")} counter={counters.eu as Counter} />
        <Cell path={verdict("r_salesops")} counter={counters.salesops as Counter} />
        <Cell path={verdict("r_cutover")} counter={counters.cutover as Counter} />
      </AppProvider>,
    );
    expect(counters.eu?.renders).toBe(1);

    act(() => {
      store.getState().setAnswer(verdict("r_eu"), "fix");
    });

    expect(counters.eu?.renders).toBe(2);
    expect(counters.salesops?.renders).toBe(1);
    expect(counters.cutover?.renders).toBe(1);
  });

  it("wakes only the row whose $self rule flipped", () => {
    const store = createEngineStore();
    store.getState().loadForm(assumptionLedger);
    const mine: Counter = { renders: 0 };
    const other: Counter = { renders: 0 };

    render(
      <AppProvider value={{ store, bridge: null }}>
        <Cell path={correction("r_eu")} counter={mine} />
        <Cell path={correction("r_salesops")} counter={other} />
      </AppProvider>,
    );

    act(() => {
      store.getState().setAnswer(verdict("r_eu"), "fix");
    });

    expect(mine.renders).toBe(2);
    expect(other.renders).toBe(1);
  });

  it("re-renders one matrix cell per click, not the grid (§5.5)", () => {
    const store = createEngineStore();
    store.getState().loadForm(matrixFls);
    const cells = ["sales_ops", "rev_ops", "support"].map(() => ({ renders: 0 }) as Counter);
    const paths = ["sales_ops", "rev_ops", "support"].map(
      (col) => `grid[Discount_Reason__c][${col}]`,
    );

    render(
      <AppProvider value={{ store, bridge: null }}>
        {paths.map((path, index) => (
          <GridCell key={path} path={path} counter={cells[index] as Counter} />
        ))}
      </AppProvider>,
    );
    expect(cells.map((cell) => cell.renders)).toEqual([1, 1, 1]);

    act(() => {
      store.getState().setAnswer(paths[1] as string, "rw");
    });
    expect(cells.map((cell) => cell.renders)).toEqual([1, 2, 1]);

    // A revert is a store DELETE, and it must be just as narrow.
    act(() => {
      store.getState().reset(paths[1] as string);
    });
    expect(cells.map((cell) => cell.renders)).toEqual([1, 3, 1]);
  });

  it("re-paints only the clicked cell in the rendered grid (§5.5)", () => {
    const store = createEngineStore();
    store.getState().loadForm(matrixFls);
    store.getState().setDisplayMode("fullscreen");
    render(
      <AppProvider value={{ store, bridge: null }}>
        <App />
      </AppProvider>,
    );
    const at = (row: string, col: string) =>
      document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement;

    const before = [...document.querySelectorAll(".mcell")].map((cell) => cell.textContent);
    fireEvent.pointerDown(at("Discount_Reason__c", "support"), { button: 0 });
    const after = [...document.querySelectorAll(".mcell")].map((cell) => cell.textContent);
    const differing = before.filter((text, index) => text !== after[index]);
    expect(differing).toHaveLength(1);
    // The counter is the one other thing that moves — it is a header pill, not
    // a cell (§5.1).
    expect(screen.getByLabelText("1 changes vs current")).toBeDefined();
  });

  it("keeps a note keystroke inside its own row", () => {
    const store = createEngineStore();
    store.getState().loadForm(assumptionLedger);
    const mine: Counter = { renders: 0 };
    const other: Counter = { renders: 0 };

    render(
      <AppProvider value={{ store, bridge: null }}>
        <Cell path="assumptions[r_eu]" counter={mine} />
        <Cell path="assumptions[r_cutover]" counter={other} />
      </AppProvider>,
    );

    act(() => {
      store.getState().setNote("assumptions[r_eu]", "check with Legal");
    });

    expect(mine.renders).toBe(2);
    expect(other.renders).toBe(1);
  });
});
