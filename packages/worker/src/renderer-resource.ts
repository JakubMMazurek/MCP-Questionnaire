/**
 * `ui://forms/renderer` — the one UI resource (§7.1).
 *
 * One resource serves every form type forever: the rendering engine ships in
 * the bundle and the schema arrives as data (tool input), so the host reviews
 * the template once and new archetypes are a server-side change only.
 *
 * Two details verified against the ext-apps 2026-01-26 spec rather than memory:
 *  - `mimeType` is `text/html;profile=mcp-app`.
 *  - `_meta.ui` travels with the CONTENTS on `resources/read`, not only on the
 *    `resources/list` declaration, so it is set in both places and the content
 *    item's copy is the one that governs.
 *
 * `ui.csp` is deliberately omitted (§3, corrected): the host's restrictive
 * default then applies — `default-src 'none'; script-src 'self' 'unsafe-inline';
 * style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'
 * data:; connect-src 'none'`. `connect-src 'none'` is the load-bearing half:
 * the app physically cannot phone home, which is why drafts travel as an
 * app-visible tool call instead of a POST. Declaring a CSP here could only
 * loosen what we want left tight.
 */

import type { WorkerEnv } from "./env.js";

export const RENDERER_URI = "ui://forms/renderer";
export const RENDERER_NAME = "Structured input renderer";
export const RENDERER_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * §7.1/§7.3 — a bordered card reads as a distinct surface inline. The host is
 * free to ignore it.
 */
export const RENDERER_UI_META = { prefersBorder: true } as const;

export const RENDERER_DESCRIPTION =
  "Renders a form schema delivered as tool input and returns the answers. One template for every archetype; the schema is data.";

/**
 * The bundle is a single self-contained HTML file built by `@gather/ui`
 * (`vite-plugin-singlefile`, verified to reference nothing external). It is
 * read through the ASSETS binding rather than embedded in the Worker source so
 * that a renderer change is an asset upload, not a code change.
 *
 * `run_worker_first: true` in wrangler.jsonc means this is the ONLY way the
 * bundle is reachable — it is not also a public page at `/`.
 */
const ASSET_URL = "http://assets.local/index.html";

export async function readRendererBundle(env: WorkerEnv): Promise<string> {
  const response = await env.ASSETS.fetch(new Request(ASSET_URL));
  if (!response.ok) {
    throw new Error(
      `the renderer bundle is missing (ASSETS returned ${response.status}). Build it: pnpm --filter @gather/ui build.`,
    );
  }
  return await response.text();
}
