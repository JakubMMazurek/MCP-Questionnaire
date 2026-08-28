#!/usr/bin/env node

/**
 * Cascade invariants for styles.css (§7.4, §8.2).
 *
 * Lives here rather than in a vitest file for two reasons: this package targets
 * the browser and carries no node types, and vitest hands back an empty string
 * for `styles.css?raw` with CSS processing off. It sits next to verify-bundle
 * because both check a property of the shipped surface that no unit test can
 * see.
 *
 * Both invariants below are field defects, and both were specificity: a rule
 * with one more pseudo-class silently outranking the rule that carried the
 * meaning.
 *
 *  1. `.seg > button:hover:not(:disabled)` (0,3,2) outranked
 *     `.seg > button[aria-checked="true"]` (0,2,2), so hovering a selected
 *     option repainted it as unselected. The pointer sits on the button right
 *     after a click — exactly when a person looks for confirmation.
 *  2. `.btn:disabled` (0,2,0) outranked `.btn-primary` (0,1,0), replacing the
 *     inverted ink while the inverted ground stayed. After submit the label
 *     flips to "Sent" and went near-invisible: an empty-looking button.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "..", "src", "styles.css");
const css = readFileSync(path, "utf8");
const lines = css.split("\n");

/** A hover rule must not outrank the state painted on the same surface. */
const HOVER_RULES = [
  [".seg > button:hover:not(:disabled)", '[aria-checked="true"]'],
  [".tile:hover:not(:disabled)", '[aria-checked="true"]'],
  [".chip-toggle:hover:not(:disabled)", '[aria-pressed="true"]'],
  [".mcell:hover:not(:disabled)", '[data-dirty="true"]'],
];

/**
 * A selected state must carry the accent, not a second host grey.
 *
 * Keyed by the ATTRIBUTE each surface actually uses, because the first version
 * of this file assumed `aria-checked` everywhere and so gave `.chip-toggle` —
 * the multi_select chip, which uses `aria-pressed` — a clean bill of health
 * while it kept both bugs. A new selectable control belongs in this list on the
 * day it is written.
 */
const SELECTED_SURFACES = [
  [".seg > button", "aria-checked"],
  [".tile", "aria-checked"],
  [".preset", "aria-checked"],
  [".palette-swatch", "aria-checked"],
  [".chip-toggle", "aria-pressed"],
];

const offences = [];

for (const [selector, excluded] of HOVER_RULES) {
  const line = lines.find((l) => l.trim().startsWith(selector));
  if (!line) {
    offences.push(`no rule starts with \`${selector}\` — did the selector move?`);
  } else if (!line.includes(`:not(${excluded})`)) {
    offences.push(
      `\`${selector}\` does not exclude ${excluded}: hover outranks the ` +
        `selected state and erases it under the pointer.`,
    );
  }
}

for (const [surface, attribute] of SELECTED_SURFACES) {
  const at = css.indexOf(`${surface}[${attribute}="true"] {`);
  if (at === -1) {
    offences.push(`no selected rule for \`${surface}\` (${attribute})`);
    continue;
  }
  const block = css.slice(at, css.indexOf("}", at));
  if (!block.includes("--color-ring-primary")) {
    offences.push(
      `\`${surface}[${attribute}="true"]\` does not use --color-ring-primary: ` +
        `two adjacent host greys are not a selected state anyone can see.`,
    );
  }
  if (block.includes("color: var(--color-background-primary)")) {
    offences.push(
      `\`${surface}[${attribute}="true"]\` puts ink ON the accent — the host ` +
        `supplies no companion contrast colour for it (§8.2).`,
    );
  }
}

if (!/\.btn-primary:disabled \{\n\s+color: var\(--color-background-primary\);/.test(css)) {
  offences.push(
    "`.btn-primary:disabled` must restate the inverted ink: `.btn:disabled` " +
      "outranks `.btn-primary`, which blanks the label after submit.",
  );
}

if (offences.length > 0) {
  console.error("verify-styles: cascade invariants broken\n");
  for (const o of offences) console.error(`  ✗ ${o}`);
  process.exit(1);
}

console.log(`verify-styles: ${HOVER_RULES.length + SELECTED_SURFACES.length + 1} invariants hold`);
