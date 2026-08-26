/**
 * The answer store — a Zustand VANILLA store (§8.1).
 *
 * Vanilla, not the React hook factory: the rules engine runs against the same
 * store from outside React, and React subscribes with per-path selectors so a
 * click re-renders one cell rather than the form (§5.5). Everything derived —
 * visibility, defaults, filtered options, counters — is recomputed here after
 * every mutation and reconciled against the previous result so that unchanged
 * entries keep their object identity; without that, every selector returning an
 * array would invalidate on every keystroke.
 *
 * The invariant that makes §4.6 work: AN ENTRY EXISTS ONLY WHERE THE USER
 * ACTED. Prefill and `set_default` never write. `answers[path] === undefined`
 * therefore means "untouched", which is exactly what `count_needs_review` and
 * `count_changed` need to know, and what lets a user's edit outrank a default.
 */

import type { Answers, Diagnostic, DisplayMode, Form, Prefill, Value } from "@gather/schema";
import { validateForm } from "@gather/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComputeContext } from "./computed.js";
import { sameValue } from "./effective.js";
import { canonicalPrefill, type Effects, EMPTY_EFFECTS, evaluate } from "./evaluate.js";
import { formLeaves, type Leaf, repeatablePaths } from "./leaves.js";
import { canon, mintRowId } from "./paths.js";

export type FormStatus =
  /** No schema yet — render skeletons, never a spinner (§7.4). */
  | "loading"
  /** A schema arrived and validated. */
  | "ready"
  /** A schema arrived and did not validate — render the plain failure state (§6.3). */
  | "invalid"
  /** `ui/notifications/tool-cancelled` — frozen, no more pushes (§7.2). */
  | "cancelled";

export type EngineState = {
  form: Form | null;
  status: FormStatus;
  diagnostics: readonly Diagnostic[];
  /** §4.7 envelope, canonical keys. */
  prefill: Readonly<Record<string, Prefill>>;
  answers: Answers;
  /** Runtime rows per `repeatable`, keyed by canonical container path (§4.5). */
  rows: Readonly<Record<string, readonly string[]>>;
  leaves: readonly Leaf[];
  effects: Effects;
  /** Condition of every rule instance at the last commit — the `clear` edge. */
  priorConditions: Readonly<Record<string, boolean>>;
  /**
   * The mode we are actually rendering in. The HOST owns this (§7.3): the
   * form's own `display` is a preference, used only until the host says
   * otherwise — the renderer must never draw a fullscreen surface into an
   * inline card because the schema asked it to.
   */
  displayMode: DisplayMode;
  /** What the host told us, if it has. */
  hostDisplayMode: DisplayMode | null;
  /** Bumps on every answer mutation. What the bridge's debouncers watch. */
  revision: number;
};

export type EngineActions = {
  loadForm: (form: unknown) => void;
  hydrate: (answers: Answers) => void;
  setAnswer: (path: string, value: unknown) => void;
  setEmpty: (path: string) => void;
  setNote: (path: string, note: string) => void;
  /** Writes `answered` entries copying the prefill value (§5.1 bulk affirm). */
  bulkAffirm: (paths: readonly string[]) => void;
  addRow: (containerPath: string) => string | null;
  removeRow: (containerPath: string, rowId: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  cancel: () => void;
};

export type EngineStore = StoreApi<EngineState & EngineActions>;

const INITIAL: EngineState = {
  form: null,
  status: "loading",
  diagnostics: [],
  prefill: {},
  answers: {},
  rows: {},
  leaves: [],
  effects: EMPTY_EFFECTS,
  priorConditions: {},
  displayMode: "inline",
  hostDisplayMode: null,
  revision: 0,
};

/* -------------------------------------------------------------------------- */
/* reference-stable effects                                                   */
/* -------------------------------------------------------------------------- */

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function reconcileMap<T>(
  prev: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  if (prev.size !== next.size) return next;
  const merged = new Map<string, T>();
  for (const [key, value] of next) {
    if (!prev.has(key)) return next;
    const before = prev.get(key) as T;
    merged.set(key, sameValue(before, value) ? before : value);
  }
  for (const [key, value] of merged) {
    if (!Object.is(prev.get(key), value)) return merged;
  }
  return prev;
}

/**
 * Keeps object identity for everything that did not actually change, so
 * `useStore(store, s => s.effects.filtered.get(path))` is stable across a
 * re-evaluation that did not touch that path.
 */
export function reconcileEffects(prev: Effects, next: Effects): Effects {
  return {
    hidden: sameSet(prev.hidden, next.hidden) ? prev.hidden : next.hidden,
    disabled: sameSet(prev.disabled, next.disabled) ? prev.disabled : next.disabled,
    required: reconcileMap(prev.required, next.required),
    filtered: reconcileMap<readonly Value[]>(prev.filtered, next.filtered),
    defaults: reconcileMap(prev.defaults, next.defaults),
    conditions: reconcileMap(prev.conditions, next.conditions),
    clears: reconcileMap<readonly string[]>(prev.clears, next.clears),
    iterations: next.iterations,
    capped: next.capped,
  };
}

/* -------------------------------------------------------------------------- */
/* the commit pipeline                                                        */
/* -------------------------------------------------------------------------- */

type Committed = {
  answers: Answers;
  effects: Effects;
  priorConditions: Record<string, boolean>;
};

/**
 * Re-evaluates after a mutation and fires edge-triggered `clear`s.
 *
 * `clear` fires on the false→true transition of its condition and nowhere else.
 * A standing "while true" clear would delete every keystroke the user typed into
 * a field that is still on screen; the transition is the event the spec means.
 */
function commit(
  form: Form,
  answers: Answers,
  rows: Readonly<Record<string, readonly string[]>>,
  leaves: readonly Leaf[],
  prefill: Readonly<Record<string, Prefill>>,
  prior: Readonly<Record<string, boolean>>,
  options: { fireClears: boolean },
): Committed {
  let current = answers;
  let effects = evaluate(form, current, { rows, prefill, leaves });
  const seen: Record<string, boolean> = { ...prior };

  if (options.fireClears) {
    for (let pass = 0; pass < 5; pass += 1) {
      const doomed = new Set<string>();
      for (const [key, targets] of effects.clears) {
        const now = effects.conditions.get(key) === true;
        const before = seen[key] === true;
        if (now && !before) for (const path of targets) doomed.add(path);
      }
      for (const [key, value] of effects.conditions) seen[key] = value;
      if (doomed.size === 0) break;

      let mutated = false;
      const next: Answers = { ...current };
      for (const path of doomed) {
        if (next[path] !== undefined) {
          delete next[path];
          mutated = true;
        }
      }
      if (!mutated) break;
      current = next;
      effects = evaluate(form, current, { rows, prefill, leaves });
    }
  }

  for (const [key, value] of effects.conditions) seen[key] = value;
  return { answers: current, effects, priorConditions: seen };
}

/* -------------------------------------------------------------------------- */
/* the store                                                                  */
/* -------------------------------------------------------------------------- */

export function createEngineStore(): EngineStore {
  return createStore<EngineState & EngineActions>((set, get) => {
    /** Applies an answers mutation: commit, reconcile, bump the revision. */
    const write = (mutate: (answers: Answers) => Answers): void => {
      const state = get();
      const form = state.form;
      if (!form || state.status !== "ready") return;
      const committed = commit(
        form,
        mutate(state.answers),
        state.rows,
        state.leaves,
        state.prefill,
        state.priorConditions,
        { fireClears: true },
      );
      set({
        answers: committed.answers,
        effects: reconcileEffects(state.effects, committed.effects),
        priorConditions: committed.priorConditions,
        revision: state.revision + 1,
      });
    };

    return {
      ...INITIAL,

      loadForm: (candidate) => {
        const result = validateForm(candidate);
        if (!result.ok || !result.form) {
          set({ status: "invalid", diagnostics: result.diagnostics, form: null });
          return;
        }
        const form: Form = result.form;
        const rows: Record<string, readonly string[]> = {};
        for (const path of repeatablePaths(form)) rows[path] = [];
        for (const section of form.sections) {
          for (const field of section.fields) {
            if (field.type === "repeatable" && field.min) {
              rows[field.id] = Array.from({ length: field.min }, () => mintRowId());
            }
          }
        }
        const leaves = formLeaves(form, rows);
        const prefill = canonicalPrefill(form);
        // The first evaluation is not a transition: a `clear` must not fire
        // just because the form arrived in a state where its condition holds.
        const committed = commit(form, {}, rows, leaves, prefill, {}, { fireClears: false });
        set({
          form,
          status: "ready",
          diagnostics: result.diagnostics,
          prefill,
          answers: committed.answers,
          rows,
          leaves,
          effects: committed.effects,
          priorConditions: committed.priorConditions,
          // The host's mode wins if it has told us one; the form's `display` is
          // only the fallback (§7.3).
          displayMode: get().hostDisplayMode ?? form.display ?? "inline",
          revision: 0,
        });
      },

      hydrate: (answers) => {
        const state = get();
        const form = state.form;
        if (!form) return;
        const canonical: Answers = {};
        for (const [path, entry] of Object.entries(answers)) canonical[canon(path)] = entry;
        const committed = commit(
          form,
          canonical,
          state.rows,
          state.leaves,
          state.prefill,
          {},
          { fireClears: false },
        );
        set({
          answers: committed.answers,
          effects: reconcileEffects(state.effects, committed.effects),
          priorConditions: committed.priorConditions,
        });
      },

      setAnswer: (path, value) => {
        const key = canon(path);
        write((answers) => {
          const note = answers[key]?.note;
          return { ...answers, [key]: { state: "answered", value, ...(note ? { note } : {}) } };
        });
      },

      setEmpty: (path) => {
        const key = canon(path);
        write((answers) => {
          const note = answers[key]?.note;
          return { ...answers, [key]: { state: "empty", ...(note ? { note } : {}) } };
        });
      },

      setNote: (path, note) => {
        const key = canon(path);
        write((answers) => {
          const existing = answers[key];
          const trimmed = note.trim();
          if (!existing) {
            // A note is an action on the path, so it creates the entry — as an
            // `empty` answer, which is what a note-only anchor submits (§4.4).
            return trimmed ? { ...answers, [key]: { state: "empty", note } } : answers;
          }
          const next: Answers = { ...answers };
          if (trimmed) next[key] = { ...existing, note };
          else if (existing.state === "answered")
            next[key] = { state: "answered", value: existing.value };
          else next[key] = { state: "empty" };
          return next;
        });
      },

      bulkAffirm: (paths) => {
        const state = get();
        write((answers) => {
          const next: Answers = { ...answers };
          for (const raw of paths) {
            const key = canon(raw);
            const prefilled = state.prefill[key];
            if (!prefilled) continue;
            const note = next[key]?.note;
            next[key] = { state: "answered", value: prefilled.value, ...(note ? { note } : {}) };
          }
          return next;
        });
      },

      addRow: (containerPath) => {
        const state = get();
        const form = state.form;
        if (!form || state.status !== "ready") return null;
        const key = canon(containerPath);
        const existing = state.rows[key] ?? [];
        const rowId = mintRowId();
        const rows = { ...state.rows, [key]: [...existing, rowId] };
        const leaves = formLeaves(form, rows);
        const committed = commit(
          form,
          state.answers,
          rows,
          leaves,
          state.prefill,
          state.priorConditions,
          { fireClears: false },
        );
        set({
          rows,
          leaves,
          answers: committed.answers,
          effects: reconcileEffects(state.effects, committed.effects),
          priorConditions: committed.priorConditions,
          revision: state.revision + 1,
        });
        return rowId;
      },

      removeRow: (containerPath, rowId) => {
        const state = get();
        const form = state.form;
        if (!form || state.status !== "ready") return;
        const key = canon(containerPath);
        const rows = {
          ...state.rows,
          [key]: (state.rows[key] ?? []).filter((id) => id !== rowId),
        };
        const leaves = formLeaves(form, rows);
        const prefix = `${key}[${rowId}]`;
        const answers: Answers = {};
        for (const [path, entry] of Object.entries(state.answers)) {
          if (path !== prefix && !path.startsWith(`${prefix}[`)) answers[path] = entry;
        }
        const committed = commit(
          form,
          answers,
          rows,
          leaves,
          state.prefill,
          state.priorConditions,
          {
            fireClears: false,
          },
        );
        set({
          rows,
          leaves,
          answers: committed.answers,
          effects: reconcileEffects(state.effects, committed.effects),
          priorConditions: committed.priorConditions,
          revision: state.revision + 1,
        });
      },

      setDisplayMode: (mode) => set({ displayMode: mode, hostDisplayMode: mode }),

      cancel: () => set({ status: "cancelled" }),
    };
  });
}

/** The context the `computed` ops and the submission builder read. */
export function computeContext(state: EngineState): ComputeContext {
  return {
    form: state.form as Form,
    leaves: state.leaves,
    answers: state.answers,
    prefill: state.prefill,
    effects: state.effects,
  };
}
