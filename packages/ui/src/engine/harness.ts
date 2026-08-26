/**
 * Test-only helpers. Kept out of `*.test.ts` so every engine test drives the
 * store the way the renderer does — load, mutate, read the same derived state.
 */

import type { Answers, Computed, Form } from "@mcpq/schema";
import { type ComputeContext, computeValue } from "./computed.js";
import { computeContext, createEngineStore, type EngineStore } from "./store.js";
import { buildSubmission, type Submission } from "./submission.js";

/** Loads a form into a fresh store and asserts it validated. */
export function loaded(form: unknown): EngineStore {
  const store = createEngineStore();
  store.getState().loadForm(form);
  const state = store.getState();
  if (state.status !== "ready") {
    throw new Error(
      `fixture did not validate:\n${state.diagnostics.map((d) => d.message).join("\n")}`,
    );
  }
  return store;
}

export function ctx(store: EngineStore): ComputeContext {
  return computeContext(store.getState());
}

export function compute(store: EngineStore, compute_: Computed): number {
  return computeValue(ctx(store), compute_);
}

/** The `computed` field with this id, evaluated. */
export function counter(store: EngineStore, id: string): number {
  const form = store.getState().form as Form;
  for (const section of form.sections) {
    for (const field of section.fields) {
      if (field.type === "computed" && field.id === id) return compute(store, field.compute);
    }
  }
  throw new Error(`no computed field "${id}"`);
}

export function submit(store: EngineStore): Submission {
  const state = store.getState();
  return buildSubmission(state.form as Form, state.answers, state.effects, state.prefill, {
    rows: state.rows,
    leaves: state.leaves,
  });
}

export function answersOf(store: EngineStore): Answers {
  return store.getState().answers;
}
