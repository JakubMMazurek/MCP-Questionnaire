/**
 * Layer 3 of five (§6.3) — the validator enforces AND teaches.
 *
 * The rule §6.3 sets is "errors + example": malformed definitions come back as
 * text in the tool result, so the agent self-corrects on the next call, and the
 * matching worked example rides along — because THAT is what makes convergence
 * work with no skill loaded and no `get_form_guide` call in the transcript.
 * Errors alone teach the letter; the example teaches the shape.
 *
 * "Matching" is decided by the closest archetype to whatever the author was
 * reaching for, read off the closed vocabulary only (§4.1 — the validator never
 * interprets labels or descriptions for meaning): a grid wants the matrix
 * example, a table wants the ledger, and everything else gets elicitation,
 * which is the smallest complete form there is.
 */

import type { ArchetypeName } from "./recipes.js";
import { examplesFor, type WorkedExample } from "./recipes.js";

/** Walks the raw input for the type tokens that identify an archetype. */
function shapeTokens(input: unknown): Set<string> {
  const found = new Set<string>();
  const seen = new Set<object>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    // Declared type, when the author got that far.
    if (typeof record.type === "string") found.add(record.type);
    // Structural giveaways, for input too broken to have a usable `type`.
    if (Array.isArray(record.cols) && Array.isArray(record.rows)) found.add("matrix");
    if (Array.isArray(record.columns)) found.add("table");
    if (typeof record.cellType === "string") found.add("matrix");
    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(input, 0);
  return found;
}

export function closestArchetype(input: unknown): ArchetypeName {
  const tokens = shapeTokens(input);
  if (tokens.has("matrix")) return "matrix";
  if (tokens.has("table")) return "ledger";
  return "elicitation";
}

/**
 * One example, serialised compactly — no indentation. The result text lands in
 * model context, and a pretty-printed 400-line ledger would cost more than the
 * error it accompanies.
 */
export function serialiseExample(example: WorkedExample): string {
  return `${example.title}\n${example.note}\n${JSON.stringify(example.form)}`;
}

/** The §6.3 pairing: the formatted diagnostics, then the closest worked example. */
export function diagnosticsWithExample(diagnosticsText: string, input: unknown): string {
  const archetype = closestArchetype(input);
  const example = examplesFor(archetype)[0];
  const shown = example
    ? `\n\nA worked example of the closest archetype (${archetype}) — same meta-schema, valid as written. Call get_form_guide("${archetype}") for the recipe behind it.\n\n${serialiseExample(example)}`
    : "";
  return `${diagnosticsText}${shown}`;
}
