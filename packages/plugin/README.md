# mcp-questionnaire plugin

One install gives a teammate the connector (the remote MCP server) and the
skill that carries the *whether* — the negative rules about when a form is
wrong (DESIGN.html §6.4).

## Access control: a GitHub allowlist

`.mcp.json` carries the deployed connector URL
(`https://mcp-questionnaire.<account>.workers.dev/mcp`). The URL is public and
carries nothing: the server authenticates every MCP request with OAuth, and the
sign-in is GitHub. On first connect your client registers itself, sends you to
GitHub, and the server checks the login GitHub returns against
`GITHUB_ALLOWED_USERS` — a comma-separated list of GitHub logins in
`packages/worker/wrangler.jsonc`, matched case-insensitively. A login that is
not on the list gets a 403 and no token.

**To add a teammate:** add their GitHub login to `GITHUB_ALLOWED_USERS` in
`packages/worker/wrangler.jsonc` and redeploy (`pnpm --filter @mcpq/worker exec
wrangler deploy`). To remove one, delete the entry and redeploy — that stops new
authorizations immediately; any token they already hold expires on its own, or
can be revoked from the `OAUTH_KV` namespace.

This replaced an earlier design in which the URL path itself was the capability
and this repo had to stay private to protect it (DESIGN.html §3). Form ids are
still capabilities internally — that part did not change.

## Install (teammates)

    /plugin marketplace add JakubMMazurek/MCP-Questionnaire
    /plugin install mcp-questionnaire@mcp-questionnaire

## What's inside

- `.mcp.json` — the remote connector (Streamable HTTP).
- `skills/gather/SKILL.md` — the §6.1 trigger/don't rules, loaded before any
  tool is selected. The craft (recipes, worked examples) is NOT here — the
  server carries it via `get_form_guide` (§6.2), so it updates by deploying the
  Worker, not by re-installing the plugin.
