# mcp-questionnaire plugin

One install gives a teammate the connector (the remote MCP server) and the
skill that carries the *whether* — the negative rules about when a form is
wrong (DESIGN.html §6.4).

## Access control: a Zero Trust policy, not a list in this repo

`.mcp.json` carries the deployed connector URL
(`https://mcp-questionnaire.365finance.workers.dev/mcp`). The URL is public and
carries nothing: every MCP request needs an OAuth token, and the only way to
get one is to sign in through **Cloudflare Access**, which federates to
**Microsoft Entra ID** and admits only members of the **Tech Team** policy in
Zero Trust. Anyone else is refused at Access's own login page and never
redirects back to this Worker at all.

**To add or remove a teammate:** edit the Tech Team rule group in Zero Trust
(Access controls → Policies). No code change and no redeploy — and nothing in
this repo lists who has access, deliberately. A leaver loses it when their
Entra account is disabled, because the policy requires Entra as the login
method. A token someone already holds expires on its own, or can be cut short
by deleting their `grant:`/`token:` keys from the `OAUTH_KV` namespace.

> Until 2026-10-26 this was a GitHub OAuth sign-in checked against a
> `GITHUB_ALLOWED_USERS` list in `wrangler.jsonc`. That variable is deleted.
> Editing it does nothing; the policy above is the only gate.

Before that, the URL path itself was the capability and this repo had to stay
private to protect it (DESIGN.html §3). Form ids are still capabilities
internally — that part never changed.

## Install

**At 365 Business Finance**, you should not need either command. The plugin is
distributed by organization sync from the private mirror
`365BusinessFinance/MCP-Questionnaire`, and the connector is added separately
under Organization settings → Connectors — syncing a plugin does *not* hand
members its bundled connector. Both are Owner-only actions. If the plugin has
not appeared for you, that is the thing to chase, not an install command.

**Anywhere else**, from the public repo:

    /plugin marketplace add JakubMMazurek/MCP-Questionnaire
    /plugin install mcp-questionnaire@mcp-questionnaire

You will still be stopped at the Access login unless you are on the Tech Team
policy, so this is mainly useful if you are running your own deployment.

## Releasing changes

The plugin updater ships by **version, not content**: any change under
`packages/plugin/` (URL, skill text, anything) must bump `version` in
`.claude-plugin/plugin.json` or `plugin update` will report "already at the
latest version" and keep the old files.

Organization sync reads the mirror's **default branch**, so push to both
remotes (`git push origin main && git push org365 main`) before asking an Owner
to sync — otherwise the sync distributes the previous version.

A teammate who is behind does not have to be told by a human. The server's tool
description carries `SKILL_CONTRACT` and instructs the agent to compare it
against the `Skill contract` line in the skill text it has loaded; on a
mismatch the agent says so once and offers `/plugin update mcp-questionnaire`,
then treats the server as the source of truth until they do. Keeping that
honest is `packages/worker/scripts/verify-contract.mjs`, run by
`pnpm --filter @mcpq/worker check`, which fails if the version in
`plugin.json`, `SKILL.md` and `guidance.ts` disagree.

## What's inside

- `.mcp.json` — the remote connector (Streamable HTTP).
- `skills/gather/SKILL.md` — the §6.1 trigger/don't rules, loaded before any
  tool is selected. The craft (recipes, worked examples) is NOT here — the
  server carries it via `get_form_guide` (§6.2), so it updates by deploying the
  Worker, not by re-installing the plugin.
