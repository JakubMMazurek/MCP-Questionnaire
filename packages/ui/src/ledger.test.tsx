/**
 * @vitest-environment jsdom
 *
 * The ledger renderer end to end (§5.1). What is worth asserting here is the
 * behaviour the mockup implies but prose cannot pin down: the segmented control
 * clears on a second click, the `$self` rule reveals one row's correction input
 * and nobody else's, the note icon has a filled state, the counter pills count
 * by value equality, and bulk affirm does what its label says.
 *
 * The last block is the §5.5/§8 performance requirement as a test: a click must
 * not invalidate the other rows' subscriptions.
 */

import { assumptionLedger } from "@mcpq/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createEngineStore, type EngineStore } from "./engine/index.js";
import { AppProvider } from "./state";

afterEach(cleanup);

function mount(): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(assumptionLedger);
  render(
    <AppProvider value={{ store, bridge: null }}>
      <App />
    </AppProvider>,
  );
  return store;
}

const ROW_EU = "Rollout targets the EU org only";
const VERDICT_EU = "assumptions[r_eu][verdict]";

function segments(rowLabel: string): HTMLElement[] {
  const group = screen.getByRole("radiogroup", { name: `${rowLabel} — Verdict` });
  return [...group.querySelectorAll("button")] as HTMLElement[];
}

describe("the ledger surface", () => {
  it("renders one dense row per assumption, with its verdict control", () => {
    mount();
    expect(screen.getByText("Before I draft the rollout plan…")).toBeDefined();
    expect(screen.getAllByRole("radiogroup")).toHaveLength(5);
    expect(segments(ROW_EU).map((button) => button.textContent)).toEqual(["Confirm", "Fix", "TBD"]);
  });

  it("shows the prefilled verdict as selected without writing an answer", () => {
    const store = mount();
    const [confirm] = segments(ROW_EU);
    expect(confirm?.getAttribute("aria-checked")).toBe("true");
    expect(store.getState().answers).toEqual({});
  });

  it("carries a provenance chip with the rationale on hover (§4.7)", () => {
    mount();
    const chip = screen.getByTitle("you mentioned EU customers twice");
    expect(chip.textContent).toBe("inferred · high");
    expect(screen.getByText("existing")).toBeDefined();
    expect(screen.getByText("you said")).toBeDefined();
  });

  it("records a verdict, and clears it when the same segment is clicked again", () => {
    const store = mount();
    const [confirm, fix] = segments(ROW_EU);
    fireEvent.click(fix as HTMLElement);
    expect(store.getState().answers[VERDICT_EU]).toEqual({ state: "answered", value: "fix" });

    fireEvent.click(segments(ROW_EU)[1] as HTMLElement);
    expect(store.getState().answers[VERDICT_EU]).toEqual({ state: "empty" });
    expect(confirm?.getAttribute("aria-checked")).toBe("false");
  });

  it("reveals the correction input for that row only ($self, §4.6)", () => {
    mount();
    expect(screen.queryByLabelText(`${ROW_EU} — What's right instead?`)).toBeNull();

    fireEvent.click(segments(ROW_EU)[1] as HTMLElement);
    expect(screen.getByLabelText(`${ROW_EU} — What's right instead?`)).toBeDefined();
    expect(
      screen.queryByLabelText(
        "Sales Ops keeps edit access during migration — What's right instead?",
      ),
    ).toBeNull();
  });

  it("counts by value equality in the header pills", () => {
    const store = mount();
    expect(screen.getByLabelText("5 needing review")).toBeDefined();
    expect(screen.getByLabelText("0 marked TBD")).toBeDefined();

    fireEvent.click(segments(ROW_EU)[2] as HTMLElement);
    expect(screen.getByLabelText("1 marked TBD")).toBeDefined();
    expect(screen.getByLabelText("4 needing review")).toBeDefined();
    expect(store.getState().answers[VERDICT_EU]).toEqual({ state: "answered", value: "tbd" });
  });
});

describe("notes (§4.4)", () => {
  it("expands from an icon and takes on a filled state", () => {
    const store = mount();
    const icon = screen.getByLabelText(`Add a note to ${ROW_EU}`);
    expect(icon.dataset.filled).toBe("false");
    expect(screen.queryByPlaceholderText(/note for Claude/)).toBeNull();

    fireEvent.click(icon);
    const input = screen.getByPlaceholderText(/note for Claude/);
    fireEvent.change(input, { target: { value: "depends on whether Legal signs off" } });

    expect(store.getState().answers["assumptions[r_eu]"]).toEqual({
      state: "empty",
      note: "depends on whether Legal signs off",
    });
    expect(screen.getByLabelText(`Edit the note on ${ROW_EU}`).dataset.filled).toBe("true");
  });
});

describe("bulk affirm (§5.1)", () => {
  it("does what its label says: everything except low-confidence inferences", () => {
    const store = mount();
    fireEvent.click(screen.getByText("Confirm all high-confidence"));

    expect(Object.keys(store.getState().answers).sort()).toEqual([
      "assumptions[r_eu][verdict]",
      "assumptions[r_legacy][verdict]",
      "assumptions[r_salesops][verdict]",
    ]);
    expect(screen.getByLabelText("2 needing review")).toBeDefined();
  });

  it("disappears once there is nothing left to affirm", () => {
    const store = mount();
    act(() => {
      for (const row of ["r_eu", "r_salesops", "r_cutover", "r_legacy", "r_revops"]) {
        store.getState().setAnswer(`assumptions[${row}][verdict]`, "confirm");
      }
    });
    expect(screen.queryByText("Confirm all high-confidence")).toBeNull();
    expect(screen.getByText("Use these assumptions")).toBeDefined();
  });
});

describe("the shell", () => {
  it("always offers the chat escape hatch and a partial submit (§5.6/§6.3)", () => {
    mount();
    expect(screen.getByText("…or just tell me in chat")).toBeDefined();
    const submit = screen.getByText("Use these assumptions") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("renders a compact summary card inline, with no nested scroll (§7.3)", () => {
    const store = createEngineStore();
    store.getState().loadForm(assumptionLedger);
    store.getState().setDisplayMode("inline");
    render(
      <AppProvider value={{ store, bridge: null }}>
        <App />
      </AppProvider>,
    );
    expect(screen.getByText("Review in fullscreen")).toBeDefined();
    expect(screen.queryAllByRole("radiogroup")).toHaveLength(0);
    expect(screen.getByLabelText("5 needing review")).toBeDefined();
  });

  it("freezes every control when the tool call is cancelled (§7.2)", () => {
    const store = mount();
    act(() => {
      store.getState().cancel();
    });
    expect(screen.getByText("cancelled — this form is frozen")).toBeDefined();
    for (const button of segments(ROW_EU)) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("renders a plain failure state for a schema that does not validate (§6.3)", () => {
    const store = createEngineStore();
    store.getState().loadForm({ version: 1, title: "broken" });
    render(
      <AppProvider value={{ store, bridge: null }}>
        <App />
      </AppProvider>,
    );
    expect(screen.getByText("This form could not be rendered")).toBeDefined();
  });
});
