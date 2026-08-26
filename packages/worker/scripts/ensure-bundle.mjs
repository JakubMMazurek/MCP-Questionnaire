#!/usr/bin/env node

/**
 * The Worker's `assets` directory is `packages/ui/dist`, which is a build
 * output and therefore gitignored. Without it, `wrangler dev` serves a Worker
 * whose only resource 404s and the test suite fails on a missing file rather
 * than on anything real.
 *
 * So: build the UI first if the bundle is absent, and say so. Ordering, not
 * cleverness — `pnpm build` at the root does the same thing unconditionally.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "..", "ui", "dist", "index.html");

if (existsSync(bundle)) process.exit(0);

console.log("ensure-bundle: packages/ui/dist/index.html is missing — building @gather/ui first.");
try {
  execFileSync("pnpm", ["--filter", "@gather/ui", "build"], { stdio: "inherit" });
} catch {
  console.error(
    "ensure-bundle: `pnpm --filter @gather/ui build` failed. The Worker cannot serve ui://forms/renderer without it.",
  );
  process.exit(1);
}

if (!existsSync(bundle)) {
  console.error(`ensure-bundle: the build ran but ${bundle} still does not exist.`);
  process.exit(1);
}
