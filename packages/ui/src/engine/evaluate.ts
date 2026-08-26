/**
 * The rules engine (DESIGN.html §4.6) — one pure function.
 *
 * The flat rule list is run top-to-bottom against EFFECTIVE values and re-run
 * until the rendered state stops changing, with a hard cap of 10 iterations.
 * Nothing here touches the store: `evaluate` maps (form, answers) to the derived
 * view state, so it can be called from a test, from the store, or twice in a row
 * with no side effects.
 *
 * Two decisions worth stating because the spec leaves them open:
 *  - Visibility/enabled defaults are inferred from the rule list: a path that is
 *    the target of a `show` rule starts hidden (otherwise `show` could never do
 *    anything), a path targeted by `enable` starts disabled. Everything else
 *    starts visible and enabled.
 *  - `clear` produces no state here. It is edge-triggered — it must fire on the
 *    false→true transition, not for as long as its condition holds, or it would
 *    keep blanking data the user can see. `evaluate` therefore only reports each
 *    rule instance's condition and the paths it would clear; the store owns the
 *    transition (see store.ts).
 */

import type { Answers, Form, Prefill, Rule, RuleOp, Value } from "@gather/schema";
import { type ParsedPath, parsePath, resolvePath } from "@gather/schema";
import {
  type Effective,
  effectiveValue,
  NO_OVERLAYS,
  type Overlays,
  sameValue,
} from "./effective.js";
import { formLeaves, type Leaf, type RowMap } from "./leaves.js";
import { canon, joinPath, withinTarget } from "./paths.js";

/** §4.6 — "small iteration cap". */
export const MAX_ITERATIONS = 10;

export type Effects = {
  /** Hidden addresses: leaf paths, field ids and section ids (resolved, not inherited). */
  hidden: ReadonlySet<string>;
  disabled: ReadonlySet<string>;
  /** `require`/`optional` overrides; absent means "whatever the field declared". */
  required: ReadonlyMap<string, boolean>;
  /** Surviving option values per path. Absent means "every declared option". */
  filtered: ReadonlyMap<string, readonly Value[]>;
  /** The `set_default` overlay — derived, never written to the store. */
  defaults: ReadonlyMap<string, unknown>;
  /** Each rule instance's condition, keyed by instance. Drives edge-triggered `clear`. */
  conditions: ReadonlyMap<string, boolean>;
  /** Paths a `clear` instance would delete, keyed by the same instance key. */
  clears: ReadonlyMap<string, readonly string[]>;
  /** Passes run. 1 means the first pass changed nothing. */
  iterations: number;
  /** True when the list never stabilised — a cycle (§4.6: the validator warns). */
  capped: boolean;
};

export const EMPTY_EFFECTS: Effects = {
  hidden: new Set(),
  disabled: new Set(),
  required: new Map(),
  filtered: new Map(),
  defaults: new Map(),
  conditions: new Map(),
  clears: new Map(),
  iterations: 0,
  capped: false,
};

/* -------------------------------------------------------------------------- */
/* rule instances                                                             */
/* -------------------------------------------------------------------------- */

type Instance = {
  /** `3` for a plain rule, `3@assumptions[r_eu]` for a `$self` expansion. */
  key: string;
  rule: Rule;
  /** Leaf paths the condition reads. More than one when it names a column. */
  reads: string[];
  /** Target addresses as declared (canonical), plus every leaf beneath them. */
  targets: string[];
  targetLeaves: string[];
};

type Container = { path: string; rowIds: readonly string[] };

function containers(form: Form, rows: RowMap): Container[] {
  const out: Container[] = [];
  for (const section of form.sections) {
    for (const field of section.fields) {
      if (field.type === "table") out.push({ path: field.id, rowIds: field.rows.map((r) => r.id) });
      if (field.type === "repeatable") out.push({ path: field.id, rowIds: rows[field.id] ?? [] });
    }
  }
  return out;
}

function needsScope(path: string): boolean {
  return path.startsWith("$self") || path.startsWith("$parent");
}

/**
 * Rewrites a `$self`/`$parent` path into the concrete path for one row. v1
 * mints rows for top-level containers only, so `$parent` from a top-level row
 * addresses the container field itself.
 */
function substitute(parsed: ParsedPath, container: Container, rowId: string): string {
  const base = parsed.head.kind === "self" ? joinPath(container.path, rowId) : container.path;
  return joinPath(base, ...parsed.steps.map((step) => step.id));
}

function expandTarget(form: Form, leaves: readonly Leaf[], target: string): string[] {
  const section = form.sections.find((s) => s.id === target);
  if (section) return leaves.filter((leaf) => leaf.section === section).map((leaf) => leaf.path);
  return leaves.filter((leaf) => withinTarget(leaf.path, target)).map((leaf) => leaf.path);
}

function buildInstances(form: Form, leaves: readonly Leaf[], rows: RowMap): Instance[] {
  const out: Instance[] = [];
  const rules = form.rules ?? [];

  for (const [index, rule] of rules.entries()) {
    const scoped = needsScope(rule.when.field) || rule.then.targets.some(needsScope);

    if (!scoped) {
      const field = canon(rule.when.field);
      const targets = rule.then.targets.map(canon);
      out.push({
        key: String(index),
        rule,
        reads: readsOf(form, leaves, field),
        targets,
        targetLeaves: targets.flatMap((t) => expandTarget(form, leaves, t)),
      });
      continue;
    }

    const whenParsed = parsePath(rule.when.field);
    if (!whenParsed.ok) continue;
    const targetParsed = rule.then.targets.map((t) => parsePath(t));
    if (targetParsed.some((t) => !t.ok)) continue;

    for (const container of containers(form, rows)) {
      for (const rowId of container.rowIds) {
        const field = needsScope(rule.when.field)
          ? substitute(whenParsed.path, container, rowId)
          : canon(rule.when.field);
        const targets = rule.then.targets.map((raw, i) => {
          const parsed = targetParsed[i];
          return needsScope(raw) && parsed?.ok
            ? substitute(parsed.path, container, rowId)
            : canon(raw);
        });
        // "Both sides resolve" — a `$self` rule instantiates only in containers
        // that actually declare the member it names (§4.6).
        if (!resolvePath(form, field).ok) continue;
        if (
          targets.some((t) => !resolvePath(form, t).ok && !form.sections.some((s) => s.id === t))
        ) {
          continue;
        }
        out.push({
          key: `${index}@${joinPath(container.path, rowId)}`,
          rule,
          reads: readsOf(form, leaves, field),
          targets,
          targetLeaves: targets.flatMap((t) => expandTarget(form, leaves, t)),
        });
      }
    }
  }
  return out;
}

/**
 * The leaves a condition reads. A path that names one cell reads one leaf; a
 * path that names a column or a container reads every cell beneath it, and the
 * condition then holds only if it holds for all of them.
 */
function readsOf(form: Form, leaves: readonly Leaf[], path: string): string[] {
  const exact = leaves.find((leaf) => leaf.path === path);
  if (exact) return [path];
  const expanded = expandTarget(form, leaves, path);
  return expanded.length > 0 ? expanded : [path];
}

/* -------------------------------------------------------------------------- */
/* conditions                                                                 */
/* -------------------------------------------------------------------------- */

function compare(op: "gt" | "lt", value: unknown, against: unknown): boolean {
  if (typeof value === "number" && typeof against === "number") {
    return op === "gt" ? value > against : value < against;
  }
  // ISO dates and other strings sort lexicographically, which is what `gt` on a
  // `date` field has to mean — there is no date type on the wire (§4.2).
  if (typeof value === "string" && typeof against === "string") {
    return op === "gt" ? value > against : value < against;
  }
  return false;
}

/**
 * One op against one effective value. Every comparison op is false on an empty
 * value — including `neq`, so a rule cannot fire on a field the user has not
 * reached yet. Only `empty`/`filled` test presence.
 */
function test(op: RuleOp, effective: Effective, against: unknown): boolean {
  if (op === "empty") return !effective.present;
  if (op === "filled") return effective.present;
  if (!effective.present) return false;
  const value = effective.value;
  switch (op) {
    case "eq":
      return sameValue(value, against);
    case "neq":
      return !sameValue(value, against);
    case "in":
      return Array.isArray(against) && against.some((candidate) => sameValue(value, candidate));
    case "gt":
    case "lt":
      return compare(op, value, against);
  }
}

/* -------------------------------------------------------------------------- */
/* the pass                                                                   */
/* -------------------------------------------------------------------------- */

type Mutable = {
  hidden: Set<string>;
  disabled: Set<string>;
  required: Map<string, boolean>;
  filtered: Map<string, readonly Value[]>;
  defaults: Map<string, unknown>;
  conditions: Map<string, boolean>;
  clears: Map<string, readonly string[]>;
};

function defaultsFor(instances: readonly Instance[]): {
  hidden: Set<string>;
  disabled: Set<string>;
} {
  const hidden = new Set<string>();
  const disabled = new Set<string>();
  for (const instance of instances) {
    const action = instance.rule.then.action;
    if (action === "show") {
      for (const target of instance.targets) hidden.add(target);
      for (const leaf of instance.targetLeaves) hidden.add(leaf);
    }
    if (action === "enable") {
      for (const target of instance.targets) disabled.add(target);
      for (const leaf of instance.targetLeaves) disabled.add(leaf);
    }
  }
  return { hidden, disabled };
}

function onePass(
  instances: readonly Instance[],
  answers: Answers,
  prefill: Readonly<Record<string, Prefill>>,
  overlays: Overlays,
  seed: { hidden: Set<string>; disabled: Set<string> },
): Mutable {
  const state: Mutable = {
    hidden: new Set(seed.hidden),
    disabled: new Set(seed.disabled),
    required: new Map(),
    filtered: new Map(),
    defaults: new Map(),
    conditions: new Map(),
    clears: new Map(),
  };
  const ctx = { answers, prefill, overlays };

  for (const instance of instances) {
    const { op, value } = instance.rule.when;
    const condition =
      instance.reads.length > 0 &&
      instance.reads.every((path) => test(op, effectiveValue(ctx, path), value));
    state.conditions.set(instance.key, condition);

    const then = instance.rule.then;
    const action = then.action;
    if (action === "clear") {
      state.clears.set(instance.key, instance.targetLeaves);
      continue;
    }
    if (!condition) continue;

    const all = [...instance.targets, ...instance.targetLeaves];
    switch (action) {
      case "show":
        for (const path of all) state.hidden.delete(path);
        break;
      case "hide":
        for (const path of all) state.hidden.add(path);
        break;
      case "enable":
        for (const path of all) state.disabled.delete(path);
        break;
      case "disable":
        for (const path of all) state.disabled.add(path);
        break;
      case "require":
        for (const path of all) state.required.set(path, true);
        break;
      case "optional":
        for (const path of all) state.required.set(path, false);
        break;
      case "filter_options": {
        const options = then.options ?? [];
        for (const path of all) {
          const previous = state.filtered.get(path);
          // Two filters on one path both constrain it: intersect, don't overwrite.
          state.filtered.set(
            path,
            previous ? previous.filter((v) => options.includes(v)) : [...options],
          );
        }
        break;
      }
      case "set_default":
        for (const path of instance.targetLeaves) state.defaults.set(path, then.value);
        break;
    }
  }
  return state;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function sameMap<T>(
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
  eq: (x: T, y: T) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    if (!eq(value, b.get(key) as T)) return false;
  }
  return true;
}

function stable(a: Mutable, b: Mutable): boolean {
  return (
    sameSet(a.hidden, b.hidden) &&
    sameSet(a.disabled, b.disabled) &&
    sameMap(a.required, b.required, (x, y) => x === y) &&
    sameMap(a.filtered, b.filtered, sameValue) &&
    sameMap(a.defaults, b.defaults, sameValue) &&
    sameMap(a.conditions, b.conditions, (x, y) => x === y)
  );
}

export type EvaluateOptions = {
  /** Runtime rows for `repeatable` fields, keyed by canonical container path. */
  rows?: RowMap;
  /** Precomputed canonical prefill / leaves, to avoid rebuilding per call. */
  prefill?: Readonly<Record<string, Prefill>>;
  leaves?: readonly Leaf[];
};

/** Canonicalises the §4.7 prefill envelope's keys. */
export function canonicalPrefill(form: Form): Record<string, Prefill> {
  const out: Record<string, Prefill> = {};
  for (const [path, entry] of Object.entries(form.prefill ?? {})) out[canon(path)] = entry;
  return out;
}

/**
 * Runs the flat rule list to a fixed point and returns the derived view state.
 * Pure: same inputs, same output, no store access.
 */
export function evaluate(form: Form, answers: Answers, options: EvaluateOptions = {}): Effects {
  const rows = options.rows ?? {};
  const leaves = options.leaves ?? formLeaves(form, rows);
  const prefill = options.prefill ?? canonicalPrefill(form);
  const instances = buildInstances(form, leaves, rows);

  if (instances.length === 0) {
    return { ...EMPTY_EFFECTS, iterations: 0, capped: false };
  }

  const seed = defaultsFor(instances);
  let overlays: Overlays = {
    hidden: seed.hidden,
    defaults: NO_OVERLAYS.defaults,
    filtered: NO_OVERLAYS.filtered,
  };
  let pass = onePass(instances, answers, prefill, overlays, seed);
  let iterations = 1;
  let capped = true;

  while (iterations < MAX_ITERATIONS) {
    overlays = { hidden: pass.hidden, defaults: pass.defaults, filtered: pass.filtered };
    const next = onePass(instances, answers, prefill, overlays, seed);
    iterations += 1;
    if (stable(pass, next)) {
      pass = next;
      capped = false;
      break;
    }
    pass = next;
  }

  return { ...pass, iterations, capped };
}
