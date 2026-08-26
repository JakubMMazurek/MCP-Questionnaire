/**
 * The path grammar (DESIGN.html §4.5) — closed, parseable, validated against
 * the schema. Not JSONPath: no wildcards, no filters, no expressions.
 *
 *   path    := segment ( "[" id "]" | "." id )*
 *   segment := id | "$self" | "$parent"
 *
 *   region
 *   fls[Discount__c][SalesOps]
 *   stakeholders[r_7f3a].owner
 *   $self.detail
 *
 * Ordinals parse (so the validator can teach about them) but are never a legal
 * address for a user-mutable row — see `resolve.ts`.
 */

/** The head of a path: a declared id, or a row-relative marker. */
export type PathHead = { kind: "id"; id: string } | { kind: "self" } | { kind: "parent" };

/** A step after the head. `syntax` is kept so `formatPath` round-trips exactly. */
export type PathStep = {
  id: string;
  syntax: "bracket" | "dot";
  /** True when the id is all digits — an ordinal, i.e. a display position. */
  ordinal: boolean;
};

export type ParsedPath = {
  /** Exactly the string that was parsed. */
  source: string;
  head: PathHead;
  steps: PathStep[];
};

export type PathParseError = {
  /** The input, verbatim. */
  source: string;
  /** 1-based character position the parse stopped at. */
  column: number;
  /** Teaching message: what is wrong, and what a legal path looks like. */
  message: string;
};

export type PathParseResult = { ok: true; path: ParsedPath } | { ok: false; error: PathParseError };

const ID_START = /[A-Za-z0-9_]/;
const ID_CHAR = /[A-Za-z0-9_\-.]/;
const ORDINAL = /^\d+$/;
const GRAMMAR = 'path := segment ("[" id "]" | "." id)*, segment := id | $self | $parent';

/**
 * Ids are `A-Za-z0-9_`, plus `-` and `.` inside brackets (Salesforce-style API
 * names like `Discount__c`, minted row ids like `r_7f3a`, dotted external keys).
 * A dot-syntax step stops at the next `.` or `[`.
 */
function readId(src: string, start: number, allowDots: boolean): { id: string; next: number } {
  let i = start;
  while (i < src.length) {
    const ch = src[i] as string;
    if (i === start ? !ID_START.test(ch) : !ID_CHAR.test(ch)) break;
    if (ch === "." && !allowDots) break;
    i += 1;
  }
  return { id: src.slice(start, i), next: i };
}

/** Parses a §4.5 path. Never throws. */
export function parsePath(source: string): PathParseResult {
  const fail = (column: number, message: string): PathParseResult => ({
    ok: false,
    error: { source, column, message },
  });

  if (typeof source !== "string" || source.length === 0) {
    return fail(1, `A path may not be empty. Grammar: ${GRAMMAR}. Example: "region".`);
  }
  if (source !== source.trim()) {
    return fail(
      1,
      `Path "${source}" has leading or trailing whitespace. Paths carry no spaces — write "${source.trim()}".`,
    );
  }

  let i = 0;
  let head: PathHead;
  if (source.startsWith("$self")) {
    head = { kind: "self" };
    i = "$self".length;
  } else if (source.startsWith("$parent")) {
    head = { kind: "parent" };
    i = "$parent".length;
  } else if (source.startsWith("$")) {
    const word = source.slice(0, source.search(/[.[]/) === -1 ? undefined : source.search(/[.[]/));
    return fail(
      1,
      `Unknown path marker "${word}". The only markers are "$self" (the current row) and "$parent" (the row or field one level up).`,
    );
  } else {
    const read = readId(source, 0, false);
    if (read.id.length === 0) {
      return fail(
        1,
        `Path "${source}" must start with a field or section id, "$self" or "$parent". Grammar: ${GRAMMAR}.`,
      );
    }
    head = { kind: "id", id: read.id };
    i = read.next;
  }

  const steps: PathStep[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (ch === "[") {
      const read = readId(source, i + 1, true);
      if (read.id.length === 0) {
        return fail(
          i + 2,
          `Nothing usable inside "[…]" in path "${source}". Brackets take a declared id or a minted row id, as in "fls[Discount__c]" — the grammar has no wildcards, filters or expressions, so this is not JSONPath (§4.5). Grammar: ${GRAMMAR}.`,
        );
      }
      if (source[read.next] !== "]") {
        return fail(
          read.next + 1,
          `Missing "]" in path "${source}". Bracket steps look like "fls[Discount__c][SalesOps]".`,
        );
      }
      steps.push({
        id: read.id,
        syntax: "bracket",
        ordinal: ORDINAL.test(read.id),
      });
      i = read.next + 1;
      continue;
    }
    if (ch === ".") {
      const read = readId(source, i + 1, false);
      if (read.id.length === 0) {
        const rest = source.slice(i + 1);
        if (rest.startsWith("$")) {
          return fail(
            i + 2,
            `"$self" and "$parent" may only start a path, not follow a "." — in "${source}", drop the marker and address the member directly.`,
          );
        }
        return fail(
          i + 2,
          `Trailing or empty "." in path "${source}". Dot steps look like "stakeholders[r_7f3a].owner".`,
        );
      }
      steps.push({
        id: read.id,
        syntax: "dot",
        ordinal: ORDINAL.test(read.id),
      });
      i = read.next;
      continue;
    }
    return fail(
      i + 1,
      `Unexpected "${ch}" in path "${source}". After the first segment, only "[id]" and ".id" steps are allowed — there are no wildcards, filters or expressions. Grammar: ${GRAMMAR}.`,
    );
  }

  return { ok: true, path: { source, head, steps } };
}

/** Renders a parsed path back to text, preserving bracket/dot syntax. */
export function formatPath(path: ParsedPath): string {
  const head = path.head.kind === "id" ? path.head.id : `$${path.head.kind}`;
  return path.steps.reduce(
    (acc, step) => acc + (step.syntax === "bracket" ? `[${step.id}]` : `.${step.id}`),
    head,
  );
}

/**
 * Syntax-independent form, for equality and map keys: every step becomes a
 * bracket step, so `a.b` and `a[b]` compare equal.
 */
export function canonicalPath(path: ParsedPath): string {
  const head = path.head.kind === "id" ? path.head.id : `$${path.head.kind}`;
  return path.steps.reduce((acc, step) => `${acc}[${step.id}]`, head);
}

/** True when any step is an ordinal (a display position used as an address). */
export function hasOrdinalStep(path: ParsedPath): boolean {
  return path.steps.some((step) => step.ordinal);
}

/** Convenience: parse and throw. For fixtures and tests, not for agent input. */
export function parsePathOrThrow(source: string): ParsedPath {
  const result = parsePath(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.path;
}
