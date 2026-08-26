# mcp-questionnaire plugin

One install gives a teammate the connector (the remote MCP server) and the
skill that carries the *whether* — the negative rules about when a form is
wrong (DESIGN.html §6.4).

## The URL is the capability

`.mcp.json` carries the deployed connector URL
(`https://mcp-questionnaire.<account>.workers.dev/<BASE_PATH>/mcp`). The
`<BASE_PATH>` segment IS the capability (DESIGN.html §3): anyone with the URL
can reach the server, so this repo must stay private, and rotating the
`BASE_PATH` secret (`wrangler secret put BASE_PATH`) revokes every copy —
then update `.mcp.json` and teammates pick it up on plugin update.

## Install (teammates)

    /plugin marketplace add JakubMMazurek/MCP-Questionnaire
    /plugin install mcp-questionnaire@mcp-questionnaire

## What's inside

- `.mcp.json` — the remote connector (Streamable HTTP).
- `skills/gather/SKILL.md` — the §6.1 trigger/don't rules, loaded before any
  tool is selected. The craft (recipes, worked examples) is NOT here — the
  server carries it via `get_form_guide` (§6.2), so it updates by deploying the
  Worker, not by re-installing the plugin.
