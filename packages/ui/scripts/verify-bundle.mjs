#!/usr/bin/env node

/**
 * Proves the bundle is self-contained (§8, §3).
 *
 * `_meta.ui.csp` is omitted, so the app runs under the host's default policy:
 * `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
 * 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`. A stylesheet link,
 * a CDN script, a webfont or a fetch does not degrade under that policy — it
 * breaks silently. So this fails the build instead.
 *
 * Absolute URLs inside JS string literals are fine and expected (XML namespace
 * constants in React, JSON Schema `$id`s in Zod, an error-docs link): none of
 * them is a request. What is checked is anything that would actually load.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * One bundle, two carriers, one rule.
 *
 * The same file is mounted by a host as `ui://forms/renderer` and served by the
 * Worker as a page; the page's policy loosens exactly one directive
 * (`connect-src 'self'`, so drafts reach the DO). Neither carrier may load
 * anything from anywhere, so the check does not care which one is running.
 */
const bundles = [{ name: "index.html", path: join(here, "..", "dist", "index.html") }];

const offences = [
  [/<script[^>]+\bsrc\s*=/i, "a <script src> — every script must be inlined"],
  [/<link[^>]+\bhref\s*=/i, "a <link href> — stylesheets and fonts must be inlined"],
  [/<(img|source|video|audio|iframe)[^>]+\bsrc\s*=\s*["']?(https?:)?\/\//i, "a remote media src"],
  [/@import\s+(url\()?["']?https?:/i, "a remote CSS @import"],
  [/url\(\s*["']?https?:/i, "a remote url() in CSS"],
  [/@font-face/i, "an @font-face — no external fonts (§8)"],
];

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
let failed = false;

for (const bundle of bundles) {
  let html;
  try {
    html = readFileSync(bundle.path, "utf8");
  } catch {
    console.error(`verify-bundle: no build at ${bundle.path} — run \`pnpm build\` first.`);
    process.exit(1);
  }

  const found = offences.filter(([pattern]) => pattern.test(html));
  for (const [, description] of found) {
    console.error(`verify-bundle: FAIL — ${bundle.name} has ${description}`);
    failed = true;
  }

  const raw = statSync(bundle.path).size;
  const gzip = gzipSync(html).length;
  if (found.length === 0) {
    console.log(`verify-bundle: ${bundle.name} self-contained. ${kb(raw)} raw, ${kb(gzip)} gzip.`);
  }
}

if (failed) process.exit(1);
