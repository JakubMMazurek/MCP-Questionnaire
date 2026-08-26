# MCP Questionnaire

Structured input surfaces inside the Claude conversation — prefilled forms,
assumption ledgers, review matrices — instead of clarifying questions as prose
bullets. The agent infers what it can, renders a form **already prefilled with
provenance on every value**, and your job is auditing a proposal, not authoring
one. Answers flow straight back into model context.

**[DESIGN.html](DESIGN.html) is the canonical spec** (open it in a browser —
the mockups are clickable). This README only tells you how to install and run.

## Install (Claude Code)

One install gives you the connector *and* the skill that knows when a form is
the right move:

    /plugin marketplace add JakubMMazurek/MCP-Questionnaire
    /plugin install mcp-questionnaire@mcp-questionnaire

or from a shell:

    claude plugin marketplace add JakubMMazurek/MCP-Questionnaire
    claude plugin install mcp-questionnaire@mcp-questionnaire

## Install (claude.ai / Claude Desktop — where the forms render)

Settings → Connectors → **Add custom connector** → paste the URL from
[`packages/plugin/.mcp.json`](packages/plugin/.mcp.json). Claude will send you
to GitHub to sign in; if your GitHub login is on the server's allowlist you come
back connected. First render asks a one-time "Always allow" permission. Add on
web/desktop first — mobile picks it up from there.

## Access control

The connector URL is public and carries nothing. Every MCP request needs an
OAuth token, and the only way to get one is to sign in with a GitHub account
whose login appears in `GITHUB_ALLOWED_USERS` in
[`packages/worker/wrangler.jsonc`](packages/worker/wrangler.jsonc) —
comma-separated, matched case-insensitively. Anyone else gets a 403 and no
token.

**Add a teammate:** add their GitHub login to `GITHUB_ALLOWED_USERS` and
redeploy the Worker. **Remove one:** delete the entry and redeploy; that blocks
new authorizations at once, and any token they still hold expires on its own (or
delete their `grant:`/`token:` keys from the `OAUTH_KV` namespace to cut it
short).

This is a deliberate reversal of the original "no auth" decision (DESIGN.html
§3): the URL path used to be the capability, which only worked while this repo
stayed private, and that stopped being true once the connector had to be
installed from a plugin marketplace. Form ids remain capabilities internally.

## Repo map

| | |
|---|---|
| `DESIGN.html` | the spec — every decision, with rationale |
| `packages/schema` | meta-schema, Zod validator with teaching errors, path parser (`@mcpq/schema`) |
| `packages/ui` | renderer: rules engine, host bridge, single-file bundle (`@mcpq/ui`) |
| `packages/worker` | Cloudflare Worker: MCP handler, form Durable Objects (`@mcpq/worker`) |
| `packages/plugin` | the installable plugin (connector + skill) |
| `.claude-plugin/` | marketplace catalog pointing at `packages/plugin` |

## Develop

    pnpm install
    pnpm -r test            # 356 tests
    pnpm --filter @mcpq/ui dev    # offline host harness at localhost:5173/dev/
    pnpm build              # single-file renderer bundle, verified self-contained

Deploying (`packages/worker`): `pnpm exec wrangler deploy`. Two secrets carry
the GitHub OAuth app's credentials —

    wrangler secret put GITHUB_CLIENT_ID
    wrangler secret put GITHUB_CLIENT_SECRET

— from a GitHub OAuth app whose **Authorization callback URL** is
`https://mcp-questionnaire.<account>.workers.dev/callback`. Pipe secrets with
`tr -d '\n'`: a trailing newline has bitten this deploy before. The allowlist
(`GITHUB_ALLOWED_USERS`) is a `vars` entry, not a secret, so it ships in
`wrangler.jsonc` and changes in a reviewable diff. `.dev.vars` holds obvious
fakes for local runs.
