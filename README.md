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

At 365 Business Finance, skip both: the plugin arrives by organization sync
from the private mirror, and the connector is added separately by an Owner.
See [`packages/plugin/README.md`](packages/plugin/README.md).

## Install (claude.ai / Claude Desktop — where the forms render)

Settings → Connectors → **Add custom connector** → paste the URL from
[`packages/plugin/.mcp.json`](packages/plugin/.mcp.json). Claude will send you
to Microsoft to sign in; if you are on the Tech Team Access policy you come
back connected. First render asks a one-time "Always allow" permission. Add on
web/desktop first — mobile picks it up from there.

## Access control

The connector URL is public and carries nothing. Every MCP request needs an
OAuth token, and the only way to get one is to sign in through **Cloudflare
Access**, which federates to **Microsoft Entra ID** and admits only members of
the **Tech Team** policy in Zero Trust. Anyone else is stopped at Access's own
login page and never reaches this Worker.

**Add or remove a teammate:** edit the Tech Team rule group in Zero Trust
(Access controls → Policies). No code change, no redeploy — and nothing in this
repo lists who has access, deliberately. A leaver loses access when their Entra
account is disabled, because the policy requires Entra as the login method. A
token someone already holds expires on its own (or
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
    pnpm -r test            # 498 tests
    pnpm --filter @mcpq/ui dev    # offline host harness at localhost:5173/dev/
    pnpm build              # single-file renderer bundle, verified self-contained

Deploying (`packages/worker`): `pnpm exec wrangler deploy`. Two secrets:

    wrangler secret put ACCESS_CLIENT_SECRET
    wrangler secret put FORM_URL_SECRET

`ACCESS_CLIENT_SECRET` comes from the **Access for SaaS** OIDC application in
Zero Trust whose **Redirect URL** is
`https://mcp-questionnaire.365finance.workers.dev/callback`; it is shown only
at creation, so getting it again means **Reset secret**. Its client id and
issuer are `vars` in `wrangler.jsonc`, not secrets — neither is a credential,
and both are visible in the public discovery document. Pipe secrets with
`tr -d '\n'`: a trailing newline has bitten this deploy before. `.dev.vars`
holds an obvious fake for local runs.
