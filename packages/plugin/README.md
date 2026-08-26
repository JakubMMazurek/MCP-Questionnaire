# gather-decisions plugin

One install gives a teammate the connector (the remote MCP server) and the
skill that carries the *whether* — the negative rules about when a form is
wrong (DESIGN.html §6.4).

## One-time setup before distributing

`.mcp.json` ships with a placeholder. Replace `REPLACE_WITH_CONNECTOR_URL` with
the deployed connector URL:

    https://gather-decisions.<account>.workers.dev/<BASE_PATH>/mcp

The `<BASE_PATH>` segment IS the capability (DESIGN.html §3): anyone with the
URL can reach the server, so this repo must stay private, and rotating the
`BASE_PATH` secret (`wrangler secret put BASE_PATH`) revokes every copy.

## Install (teammates)

    /plugin marketplace add JakubMMazurek/MCP-Questionnaire
    /plugin install gather-decisions@mcp-questionnaire

## What's inside

- `.mcp.json` — the remote connector (Streamable HTTP).
- `skills/gather/SKILL.md` — the §6.1 trigger/don't rules, loaded before any
  tool is selected. The craft (recipes, worked examples) is NOT here — the
  server carries it via `get_form_guide` (§6.2), so it updates by deploying the
  Worker, not by re-installing the plugin.
