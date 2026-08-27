#!/usr/bin/env node

/**
 * The skill contract version must be the same number in three places (§6.1).
 *
 * Two release channels meet here and drift silently: the plugin's skill file
 * ships by VERSION over git, this Worker's tool descriptions ship by DEPLOY.
 * When they disagree the agent follows an old skill against a new server — the
 * failure that had a field session reaching for load_form to read answers,
 * because its instructions predated get_answers.
 *
 * `SKILL_CONTRACT` is what the server tells the agent to compare against, so
 * these three must agree or the announcement is worse than none:
 *   1. SKILL_CONTRACT in src/guidance.ts
 *   2. version in packages/plugin/.claude-plugin/plugin.json
 *   3. the "Skill contract X" line in the skill itself
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const guidance = read("packages", "worker", "src", "guidance.ts");
const manifest = read("packages", "plugin", ".claude-plugin", "plugin.json");
const skill = read("packages", "plugin", "skills", "gather", "SKILL.md");

const found = {
  "SKILL_CONTRACT (guidance.ts)": guidance.match(/SKILL_CONTRACT = "([^"]+)"/)?.[1],
  "version (plugin.json)": JSON.parse(manifest).version,
  "Skill contract (SKILL.md)": skill.match(/\*\*Skill contract ([0-9]+(?:\.[0-9]+)*)\.\*\*/)?.[1],
};

const missing = Object.entries(found).filter(([, v]) => !v);
if (missing.length > 0) {
  console.error("verify-contract: could not find the version in:\n");
  for (const [where] of missing) console.error(`  ✗ ${where}`);
  process.exit(1);
}

const values = [...new Set(Object.values(found))];
if (values.length > 1) {
  console.error("verify-contract: the skill contract version has drifted\n");
  for (const [where, value] of Object.entries(found)) console.error(`  ${value}  ${where}`);
  console.error(
    "\nBump all three together: the server tells the agent to compare its skill\n" +
      "against SKILL_CONTRACT, so a mismatch here makes that check lie.",
  );
  process.exit(1);
}

console.log(`verify-contract: skill contract ${values[0]} agrees in all three places`);
