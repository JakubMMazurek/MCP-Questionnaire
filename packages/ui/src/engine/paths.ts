/**
 * Path plumbing for the engine.
 *
 * Every path the engine stores, compares or keys a map by is CANONICAL (§4.5,
 * `canonicalPath`): `assumptions.verdict` and `assumptions[verdict]` are the
 * same address, so they must be the same string before anything compares them.
 * The agent writes either syntax; the store only ever sees one.
 */

import { canonicalPath, parsePath } from "@gather/schema";

/**
 * Canonical form of a path, or the input verbatim when it does not parse.
 *
 * Unparsable paths only reach here from a form that failed validation (the
 * renderer refuses to render those, §6.3) — returning the raw string keeps this
 * total rather than throwing deep inside a render.
 */
export function canon(path: string): string {
  const parsed = parsePath(path);
  return parsed.ok ? canonicalPath(parsed.path) : path;
}

/** `["a","b","c"]` from `a[b][c]`. The head is the first element. */
export function segments(canonical: string): string[] {
  const head = canonical.indexOf("[");
  if (head === -1) return [canonical];
  const out = [canonical.slice(0, head)];
  const re = /\[([^\]]*)\]/g;
  let match = re.exec(canonical);
  while (match) {
    out.push(match[1] as string);
    match = re.exec(canonical);
  }
  return out;
}

/** Builds a canonical path from a head id and further steps. */
export function joinPath(head: string, ...steps: string[]): string {
  return steps.reduce((acc, step) => `${acc}[${step}]`, head);
}

/**
 * True when `leaf` lies within `target` — the engine's mirror of
 * `prefillWithinTarget` in packages/schema/src/validate.ts, which is what makes
 * a `computed` target that names a container or a column expand to cells
 * (§4.2). The target's steps must appear in the leaf's steps in order, not
 * necessarily adjacently, so `assumptions[verdict]` covers
 * `assumptions[r_eu][verdict]`.
 */
export function withinTarget(leaf: string, target: string): boolean {
  if (leaf === target) return true;
  const l = segments(leaf);
  const t = segments(target);
  if (l[0] !== t[0]) return false;
  let matched = 1;
  for (let i = 1; i < l.length && matched < t.length; i += 1) {
    if (l[i] === t[matched]) matched += 1;
  }
  return matched === t.length;
}

const ROW_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Mints a row id for a runtime-added `repeatable` row (§4.5): `r_` + 4 base36
 * characters, never all digits — an all-digit tail would parse as an ordinal
 * step and the resolver rejects ordinal row addressing with a teaching error.
 */
export function mintRowId(random: () => number = Math.random): string {
  let tail = "";
  for (let i = 0; i < 4; i += 1) {
    tail += ROW_ID_CHARS[Math.floor(random() * ROW_ID_CHARS.length)] as string;
  }
  if (!/[a-z]/.test(tail)) {
    const at = Math.floor(random() * tail.length);
    const letter = LETTERS[Math.floor(random() * LETTERS.length)] as string;
    tail = tail.slice(0, at) + letter + tail.slice(at + 1);
  }
  return `r_${tail}`;
}
