/**
 * React's window onto the engine.
 *
 * Every hook here selects ONE path's worth of derived state and returns a
 * primitive or a reference-stable object, which is what makes §5.5's "a click
 * re-renders one cell, not eight hundred" true rather than aspirational: the
 * store reconciles its effects so unchanged entries keep their identity, and
 * Zustand's default `Object.is` comparison then stops the re-render at the
 * component that actually changed.
 */

import type { Computed, Field, Prefill, Value } from "@gather/schema";
import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import {
  computeContext,
  computeValue,
  type EngineState,
  type EngineStore,
  effectiveValue,
  isVisible,
  malformedReason,
  malformedValues,
  sameValue,
} from "./engine/index.js";
import type { Bridge } from "./host/index.js";

export type AppContextValue = { store: EngineStore; bridge: Bridge | null };

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppProvider is missing");
  return value;
}

export function useEngineStore(): EngineStore {
  return useApp().store;
}

export function useBridge(): Bridge | null {
  return useApp().bridge;
}

export function useEngine<T>(selector: (state: EngineState) => T): T {
  return useStore(useEngineStore(), selector);
}

/** The store's actions, which never change identity. */
export function useActions() {
  const store = useEngineStore();
  return store.getState();
}

/* -------------------------------------------------------------------------- */
/* per-path selectors                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The value this path renders — stored answer, else the `set_default` overlay,
 * else prefill, else undefined (§4.6). Scalar for every field type the v1
 * renderer draws, so the default equality check is enough.
 */
export function useEffective(path: string): unknown {
  return useEngine((state) => {
    const effective = effectiveValue(
      { answers: state.answers, prefill: state.prefill, overlays: state.effects },
      path,
    );
    return effective.present ? effective.value : undefined;
  });
}

/**
 * Where the rendered value came from. Not used by the ledger; it is what the
 * matrix archetype's dirty-cell marks read (§5.5), and it belongs next to the
 * value it describes.
 */
export function useOrigin(path: string): "answer" | "default" | "prefill" | null {
  return useEngine((state) => {
    const effective = effectiveValue(
      { answers: state.answers, prefill: state.prefill, overlays: state.effects },
      path,
    );
    return effective.present ? effective.origin : null;
  });
}

export function useVisible(path: string): boolean {
  return useEngine((state) => isVisible(state.effects, path));
}

export function useDisabled(path: string): boolean {
  return useEngine((state) => state.effects.disabled.has(path) || state.status !== "ready");
}

export function useRequired(path: string, declared: boolean | undefined): boolean {
  return useEngine((state) => state.effects.required.get(path) ?? declared ?? false);
}

export function useNote(path: string): string | undefined {
  return useEngine((state) => state.answers[path]?.note);
}

export function useTouched(path: string): boolean {
  return useEngine((state) => state.answers[path] !== undefined);
}

/** The §4.7 envelope for a path. Stable: prefill entries are never mutated. */
export function usePrefill(path: string): Prefill | undefined {
  return useEngine((state) => state.prefill[path]);
}

/**
 * Surviving option values, or undefined for "every declared option". Stable by
 * reference across re-evaluations that did not touch this path.
 */
export function useFilteredOptions(path: string): readonly Value[] | undefined {
  return useEngine((state) => state.effects.filtered.get(path));
}

/** A `computed` field's value. Recomputed only when the store changes. */
export function useComputed(compute: Computed): number {
  return useEngine((state) => computeValue(computeContext(state), compute));
}

/**
 * Why this path's own value is impossible, or null (§6.3). The control renders
 * it in place: the submit gate names the first offender, but the fix happens at
 * the field, so the sentence has to be there too.
 */
export function useMalformed(path: string, field: Field): string | null {
  const value = useEffective(path);
  return value === undefined ? null : malformedReason(field, value);
}

/**
 * The set-level verdict on one `allocation` (§4.2 — "the constraint is on the
 * set"). Keyed by the field path, which is also where the rail jumps to.
 */
export function useFieldMalformed(fieldPath: string): string | null {
  return useEngine((state) => {
    const values = { answers: state.answers, prefill: state.prefill, overlays: state.effects };
    const hit = malformedValues(state.leaves, values, state.effects).find(
      (entry) => entry.path === fieldPath,
    );
    return hit ? hit.reason : null;
  });
}

/**
 * Runtime rows of a `repeatable` (§4.5 — client-minted ids). Reference-stable:
 * the store replaces the array only when rows change.
 */
export function useRows(containerPath: string): readonly string[] {
  return useEngine((state) => state.rows[containerPath] ?? EMPTY_ROWS);
}

const EMPTY_ROWS: readonly string[] = [];

/**
 * True when this path differs from its `source: "existing"` baseline (§4.7) —
 * the matrix's dirty mark. Written out longhand rather than borrowing
 * `isChanged`, which needs the leaf: finding a leaf is a scan, and a scan per
 * cell per store notification is exactly the cost §5.5 exists to avoid.
 *
 * A changed-to-EMPTY cell is dirty, not merely blank: the user's decision to
 * clear an existing value is a change, and it must look like one.
 */
export function useDirty(path: string): boolean {
  return useEngine((state) => {
    if (state.answers[path] === undefined) return false;
    const effective = effectiveValue(
      { answers: state.answers, prefill: state.prefill, overlays: state.effects },
      path,
    );
    const baseline = state.prefill[path];
    if (baseline?.source !== "existing") return effective.present;
    return !(effective.present && sameValue(effective.value, baseline.value));
  });
}

/** Values a per-cell `matrix` constraint restricts a leaf to, or undefined (§5.5). */
export function useAllowed(path: string): readonly Value[] | undefined {
  return useEngine((state) => state.leaves.find((leaf) => leaf.path === path)?.allowed);
}

/**
 * The mode we are rendering in (§7.3). Controls read it to decide whether they
 * may use the top layer at all: inline cards get no popovers, ever.
 */
export function useDisplayMode(): "inline" | "fullscreen" {
  return useEngine((state) => (state.displayMode === "inline" ? "inline" : "fullscreen"));
}

/** True on a phone (§7.3 — editing a dense grid is a desktop affordance). */
export function useMobile(): boolean {
  return useEngine((state) => state.platform === "mobile");
}

export function useFrozen(): boolean {
  return useEngine((state) => state.status !== "ready");
}

/** The bridge's one line of plumbing news, or null (§3 — autosave refusals). */
export function useDraftStatus(): string | null {
  return useEngine((state) => state.draftStatus);
}
