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

import type { Computed, Prefill, Value } from "@gather/schema";
import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import {
  computeContext,
  computeValue,
  type EngineState,
  type EngineStore,
  effectiveValue,
  isVisible,
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

export function useFrozen(): boolean {
  return useEngine((state) => state.status !== "ready");
}
