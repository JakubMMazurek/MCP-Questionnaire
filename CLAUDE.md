# MCP Questionnaire — build rules

**DESIGN.html is the canonical spec.** Read it before implementing anything. Every
`decided` chip is settled — do not re-litigate or "improve" a decided item; if you
believe one is wrong, stop and surface it instead of coding around it.

## Non-negotiable invariants (from the spec)

- **Closed vs free (§4.1):** the renderer and validator branch ONLY on closed
  vocabularies (field types, render hints, rule ops/actions, computed ops, source
  values). Labels, descriptions, rationale, notes are free text — never parsed,
  never matched for meaning. Matching agent-declared *values* by equality is fine.
- **Paths (§4.5):** closed grammar, no JSONPath. Ordinals are display-only;
  user-mutable rows use client-minted ids (`r_7f3a`). Reject ordinal addressing in
  validation with a teaching error.
- **Not rendered = empty (§4.6):** the submit payload is a function of the rendered
  view and nothing else. Hidden fields contribute `empty`. `set_default` writes only
  into `empty` fields. Rule evaluation re-runs the flat list until the rendered
  state is stable (iteration cap; validator warns on potential cycles).
- **Only malformed values gate (§6.3):** `require` marks, never blocks. Partial
  submit is always available.
- **No special defer state (§4.3):** defer options are ordinary agent-defined
  options; `computed` counts by value equality.
- **Zero runtime fetches (§8):** the UI bundle runs under CSP `connect-src 'none'`.
  No CDN, no external fonts, no telemetry. Everything inlined at build.
- **Never hardcode structural colors (§7.4):** host CSS variables with `:root`
  fallbacks. Provenance chips are the only semantic color system.

## Validator error messages are a product surface

Every schema error must (a) name the exact path/index, (b) say what to do instead,
(c) where §6.3 specifies it, be paired with the matching worked example. "Invalid
input" is a bug.

## Toolchain (§8.1 — decided)

pnpm workspaces: `packages/schema` (types + Zod validator + path parser; imported by
worker AND ui), `packages/ui` (React renderer, Vite single-file bundle),
`packages/worker` (createMcpHandler + form Durable Object). Zustand answer store
with per-path selectors. Vitest (+ @cloudflare/vitest-pool-workers for the worker).
Biome. TypeScript strict. wrangler.jsonc, compatibility date ≥ 2026-02-24.

## Currency rule

The MCP SDK v2 (`@modelcontextprotocol/server`) is beta and Cloudflare APIs move:
verify signatures against live docs (developers.cloudflare.com, the ext-apps spec)
rather than trusting memory or this repo's snapshot. The original design draft aged
in weeks; assume anything platform-shaped can too.

## Conventions

- Commit locally with clear messages; do not push unless asked.
- Schema envelope carries a version field from day one.
- Tests colocated per package; the validator's teaching errors get snapshot tests.
