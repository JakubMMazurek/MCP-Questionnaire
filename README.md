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

You need read access to this repo — installation sparse-clones
`packages/plugin` from GitHub with your git credentials, and the private repo
is the access control: the connector URL inside it is the capability.

## Install (claude.ai / Claude Desktop — where the forms render)

Settings → Connectors → **Add custom connector** → paste the URL from
[`packages/plugin/.mcp.json`](packages/plugin/.mcp.json). No auth to configure;
the URL path is the auth. First render asks a one-time "Always allow"
permission. Add on web/desktop first — mobile picks it up from there.

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
    pnpm -r test            # 334 tests
    pnpm --filter @mcpq/ui dev    # offline host harness at localhost:5173/dev/
    pnpm build              # single-file renderer bundle, verified self-contained

Deploying (`packages/worker`): `pnpm exec wrangler deploy`. The `BASE_PATH`
secret is the unguessable path segment — set it with
`openssl rand -hex 16 | tr -d '\n' | wrangler secret put BASE_PATH`
(the `tr` matters: a trailing newline fails the Worker's closed pattern and it
serves nothing). Rotating the secret revokes every copy of the old URL.
