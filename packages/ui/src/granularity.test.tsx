/**
 * @vitest-environment jsdom
 *
 * The §5.5/§8 performance requirement, as a test: "a click re-renders one cell,
 * not eight hundred". The mechanism is per-path selectors over a reconciled
 * effects object, so the honest way to test it is to subscribe with the very
 * hooks the cells use and count renders.
 */

import { assumptionLedger } from "@gather/schema";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createEngineStore } from "./engine/index.js";
import { AppProvider, useEffective, useFilteredOptions, useNote, useVisible } from "./state";

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
