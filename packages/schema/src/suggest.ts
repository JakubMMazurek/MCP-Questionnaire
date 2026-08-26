/**
 * "Did you mean" support for the teaching errors. A closed vocabulary is only
 * useful to the agent if a near miss says which member was probably meant.
 */

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...Array.from({ length: cols - 1 }, () => 0)];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[cols - 1] as number;
}

/** The closest candidate, if it is close enough to be worth suggesting. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: { candidate: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = distance(needle, candidate.toLowerCase());
    if (!best || score < best.score) best = { candidate, score };
  }
  if (!best) return undefined;
  const tolerance = Math.max(2, Math.floor(needle.length / 3));
  return best.score <= tolerance ? best.candidate : undefined;
}

/** ` Did you mean "x"?` — or nothing, when nothing is close. */
export function didYouMean(input: unknown, candidates: readonly string[]): string {
  if (typeof input !== "string") return "";
  const match = closest(input, candidates);
  return match ? ` Did you mean "${match}"?` : "";
}
