/**
 * The effective-value layer — the single read path for every value in the app.
 *
 * Order (decided): the stored answer if the user acted on the path; else an
 * active `set_default` overlay; else the prefill value; else empty. Prefill and
 * `set_default` are DERIVED overlays and never write to the store, which is how
 * §4.6's "`set_default` writes only into empty fields" holds by construction —
 * a user edit is an earlier layer, so it always wins — and how a user can clear
 * a prefilled field at all (an explicit `empty` entry outranks the prefill).
 *
 * Two more §4.6 consequences live here, so nothing else has to remember them:
 * a hidden path reads empty ("not rendered = empty", for rule reads too), and a
 * value that `filter_options` no longer offers reads empty even though the raw
 * entry survives in the store.
 */

import type { Answers, Prefill, Value } from "@gather/schema";

/** Canonical-path-keyed prefill. */
export type PrefillMapCanonical = Readonly<Record<string, Prefill>>;

export type Overlays = {
  /** Resolved hidden set: leaf paths, field ids and section ids. */
  hidden: ReadonlySet<string>;
  /** `set_default` values, by canonical path. */
  defaults: ReadonlyMap<string, unknown>;
  /** Surviving option values per path (`filter_options`). */
  filtered: ReadonlyMap<string, readonly Value[]>;
};

export const NO_OVERLAYS: Overlays = {
  hidden: new Set(),
  defaults: new Map(),
  filtered: new Map(),
};

export type EffectiveOrigin = "answer" | "default" | "prefill";

export type Effective =
  | { present: false }
  | { present: true; value: unknown; origin: EffectiveOrigin };

const ABSENT: Effective = { present: false };

/** Everything the read path needs: the store's answers, prefill and overlays. */
export type ValueContext = {
  answers: Answers;
  prefill: PrefillMapCanonical;
  overlays: Overlays;
};

function survivesFilter(
  value: unknown,
  surviving: readonly Value[] | undefined,
): { ok: true; value: unknown } | { ok: false } {
  if (!surviving) return { ok: true, value };
  if (Array.isArray(value)) {
    const kept = value.filter((v) => surviving.includes(v as Value));
    return kept.length > 0 ? { ok: true, value: kept } : { ok: false };
  }
  return surviving.includes(value as Value) ? { ok: true, value } : { ok: false };
}

/** The value a path renders and submits, per the layer order above. */
export function effectiveValue(ctx: ValueContext, path: string): Effective {
  if (ctx.overlays.hidden.has(path)) return ABSENT;

  const filter = ctx.overlays.filtered.get(path);
  const keep = (value: unknown, origin: EffectiveOrigin): Effective => {
    const survived = survivesFilter(value, filter);
    return survived.ok ? { present: true, value: survived.value, origin } : ABSENT;
  };

  const stored = ctx.answers[path];
  if (stored !== undefined) {
    return stored.state === "answered" ? keep(stored.value, "answer") : ABSENT;
  }
  if (ctx.overlays.defaults.has(path)) {
    return keep(ctx.overlays.defaults.get(path), "default");
  }
  const prefilled = ctx.prefill[path];
  if (prefilled !== undefined) return keep(prefilled.value, "prefill");
  return ABSENT;
}

/** True when the user has acted on this path — the only thing that writes an entry. */
export function isTouched(answers: Answers, path: string): boolean {
  return answers[path] !== undefined;
}

/** The `source: "existing"` baseline a `count_changed` diff is measured against (§4.7). */
export function baselineOf(prefill: PrefillMapCanonical, path: string): Prefill | undefined {
  const entry = prefill[path];
  return entry?.source === "existing" ? entry : undefined;
}

/** Structural equality for answer values (scalars, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    return (
      ka.length === kb.length &&
      ka.every((key, i) => key === kb[i]) &&
      ka.every((key) =>
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}
