# Proposal — the standalone browser route (a §10 for DESIGN.html)

**Status: proposal, with §8 resolved 2026-09-09.** Both open questions were
answered by Jakub and are recorded there as `decided`; the rest still awaits a
fold into DESIGN.html. Written 2026-09-09 against DESIGN.html
§3, §7.1–§7.4, §8.1, and the code as it stands at commit `08f740c`.

## 1. The problem this solves

The form reaches a person through exactly one carrier today: a host that mounts
`ui://forms/renderer` as an MCP App. Chat, Cowork, Desktop chat and mobile do
that. **Claude Code does not, and the capability is not merely switched off —
it is absent.** Re-verified 2026-09-09:

- The [MCP Apps client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
  lists Claude web, Claude Desktop, VS Code Copilot, M365 Copilot, Goose,
  Postman, MCPJam, ChatGPT, Cursor, Archestra, PostHog Code. Claude Code is
  absent.
- CLI `2.1.178`: zero occurrences of `ui://`, `ext-apps`, `resourceUri`,
  `outputTemplate`. There is no iframe host to unlock.

Two escape hatches were tested and closed:

- **The desktop app's `show_widget` cannot host the renderer.** Its widget
  sandbox blocks `fetch` to any non-CDN origin (observed: `TypeError`) *and*
  blocks framing any external origin. A frame pointed at the worker fired a
  `load` event and painted blank while `wrangler tail` recorded no request at
  all — a control `curl` to the same URL appeared in the tail within seconds.
  The request never left the browser. `cdn.jsdelivr.net` was blocked the same
  way despite being on the widget's own `resourceDomains` allowlist, so that
  allowlist governs subresources, not frames.
- Therefore a widget form would be model-authored HTML that forks the renderer,
  with answers returning only as chat text. Rejected: §4.1's closed-vocabulary
  branching, §4.6's rule loop and §6.3's gate would live in improvised markup
  instead of the tested package.

What *is* available in Claude Code, documented and confirmed in the binary
(`elicitation/create` ×10, `elicitInput` ×5), is **elicitation** — including
**URL mode**, where the server hands back a URL, the client opens it, and the
user confirms in the session when they are done. The installed SDK
(`@modelcontextprotocol/server` 2.0.0) already exposes
`elicitInput(ElicitRequestFormParams | ElicitRequestURLParams)`.

So: keep the renderer, change the carrier. Serve the existing bundle as an
ordinary web page from the worker, and point the user at it.

## 2. What does not change

This is the load-bearing claim of the proposal. The standalone route is a third
carrier for the same renderer, not a second product.

- **`packages/schema` is untouched.** Same validator, same path grammar, same
  teaching errors, same snapshots.
- **The rules engine, the fields, `App.tsx`, the answer store are untouched.**
- **The Durable Object stays the store.** Answers land in `FormDO` exactly as
  they do now, through the same `saveDraft` shape, the same
  `MAX_DRAFT_BYTES` cap and the same `MIN_DRAFT_INTERVAL_MS` throttle
  ([packages/worker/src/form-do.ts](packages/worker/src/form-do.ts)).
- **`get_answers(formId)` is unchanged and remains the pull.** §7.2's correction
  — that the context channel is advisory and the answers must be pullable —
  applies identically here. The agent's way of learning the answers does not
  depend on which carrier rendered the form.
- **The `ui://` route keeps working.** Chat, Cowork, Desktop chat and mobile are
  unaffected; §7.1's declaration, `_meta.ui`, the CSP defaults and the
  `save_draft` tool call all stay as they are.

## 3. The seam it plugs into

`Bridge` is already an interface, and `main.tsx` is already the only place that
picks an implementation ([packages/ui/src/host/bridge.ts:94](packages/ui/src/host/bridge.ts)):

```
start · hostContext · submit · requestDisplayMode · reportSize
observe · flush · formId · frozen · stop
```

The standalone build supplies a second implementation of that same interface
and reuses everything above it:

| Bridge member | MCP App carrier (today) | Standalone carrier |
| --- | --- | --- |
| `start` | `ui/initialize` handshake, host context | reads schema inlined in the page; theme from `prefers-color-scheme` and §7.4's `:root` fallbacks |
| draft flush | `tools/call save_draft` via host | `POST` same-origin to the worker |
| `submit` | `ui/update-model-context` + `ui/message` receipt | `POST` marks `submitted: true`; page shows the receipt and says to return to the session |
| `requestDisplayMode` | `ui/request-display-mode` | no-op; the tab is fullscreen by definition |
| `reportSize` / `observe` | `ui/notifications/size-changed` | no-op |
| `formId` | learned from the §3 stub result | in the page, from the signed URL |

**Build:** a second Vite entry (`standalone.html`) beside `index.html`, same
`vite-plugin-singlefile`, same zero external references. `packages/ui/dist/`
gains one more self-contained file; the ASSETS binding already serves that
directory.

## 4. New worker surface

`OAuthProvider` owns `fetch` and currently 404s everything that is not
`/mcp`, `/authorize`, `/callback` or its own metadata
([packages/worker/src/index.ts](packages/worker/src/index.ts)). Two routes are
added to the default handler:

- **`GET /f/:token`** — serves the standalone bundle with the form's schema and
  any existing draft inlined into the HTML. One document, no runtime fetch to
  render.
- **`POST /f/:token`** — a draft or a submit, straight into `FormDO.saveDraft`.

`run_worker_first: true` stays as it is: the ASSETS binding is still read only
by worker code, never exposed as a public directory.

### The token

The formId is a capability internally (§3) and must not become a URL you can
paste. The token is instead an HMAC over `formId`, an expiry and the GitHub
login that requested it, signed with a worker **secret**.

- TTL of 12 hours (`decided` — see §8 Q2), checked on both routes. Long enough
  that a form survives lunch, a laptop lid, or being forwarded to a colleague's
  machine; short enough that a leaked link is not a standing grant. The DO's own
  30-day idle expiry is unchanged and independent.
- The GitHub login is signed INTO the token for provenance and revocation, and
  is deliberately not checked against the viewer — the page has no login, and
  forwarding a form to the person who should answer it is a legitimate use.
- An expired token renders a page that says what happened and what to do — the
  §6.3 standard for error text applies to this page too.
- **Deploy trap, already bitten once:** the signing key is a `wrangler secret`,
  never a `vars` entry (a `vars` entry of the same name replaces the secret),
  and it must be piped in without a trailing newline.

### Response headers

The page is served by us, so the CSP is ours to set rather than the host's:
`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none';
frame-ancestors 'none'`. `connect-src 'self'` is Q1's answer and the only
loosening; `frame-ancestors 'none'` keeps the page out of anyone else's iframe,
including the widget sandbox that started this. Self-contained
bundle, no CDN, no external fonts, no telemetry — §8's substance, restated for a
context that has no host to impose it.

## 5. How the user gets there

One URL, three ways to hand it over, in descending order of polish:

1. **Browser pane (Claude Code desktop).** The agent opens the URL in the
   in-app browser: the form appears in the same window as the session. Verified
   working 2026-09-09 — the dev harness renders and accepts clicks in the pane.
2. **URL-mode elicitation.** `elicitInput({ mode: "url", … })` — Claude Code
   opens the system browser and waits for the user to confirm, then the tool
   call resumes. Documented client behaviour, and the SDK in this repo already
   has the params type.
3. **A link in the receipt.** Any client at all, terminal CLI included. The
   agent then polls `get_answers` exactly as it does today.

All three end in the same place: answers in the DO, `get_answers` renders them
as prose.

## 6. Test plan

Colocated as always, per CLAUDE.md.

- **Worker (`@cloudflare/vitest-pool-workers`):** token accepted / expired /
  tampered / wrong-user; `GET` returns the bundle with the schema inlined;
  `POST` respects `MAX_DRAFT_BYTES` and the throttle; a submit stamps
  `submittedAt`; `get_answers` reads back what the page wrote.
- **UI:** a standalone-bridge suite mirroring the cases in
  [packages/ui/src/host/bridge.test.ts](packages/ui/src/host/bridge.test.ts) —
  submit sends the whole rendered view once, teardown flushes without marking
  submitted, a refused draft backs off rather than counting a failure.
- **Unchanged:** every existing schema, engine and validator test must still
  pass untouched. If any of them need editing, the seam was drawn wrong.

## 7. What this costs, honestly

- A second renderer entry point to keep alive — small, but it is a second thing
  that can rot. Mitigated by the `Bridge` interface being the only difference.
- A public HTTP surface on a worker that currently has none, guarded by a
  signed URL rather than by identity. That is genuinely weaker than the bearer
  token on `/mcp`, and it is the reason for the short TTL.
- Drafts now have two write paths into the same DO method.

## 8. The two questions, answered

**Q1 — the CSP for the standalone page. `connect-src 'self'`.** `decided
2026-09-09` §8's `connect-src 'none'` is the *host's* default under MCP Apps,
applied because §7.1 deliberately omits `ui.csp`; it is not a policy this repo
chose for itself, and there is no host here to impose one. §3 put drafts in the
DO because the iframe *could not* POST — that constraint is absent from a page
we serve ourselves. So the page may talk to its own origin and nothing else,
and drafts autosave into the DO exactly as §3 intends.

Rejected, and why worth recording: keeping `'none'` and submitting through a
native `<form method="post">` preserves the letter of §8 (`form-action` is a
separate directive, so no fetch occurs) but costs mid-fill autosave; keeping
`'none'` with `localStorage` drafts keeps autosave but silently moves a
person's half-finished answers out of the DO and into their browser.

Everything else §8 asks for still holds and is not negotiable here: one
self-contained bundle, no CDN, no external fonts, no telemetry.

**Q2 — token or login? Signed URL, 12-hour TTL.** `decided 2026-09-09`
Requiring the GitHub OAuth flow before every form was rejected as too much
friction for someone who just wants to answer four questions. The signed URL is
weaker than the bearer token on `/mcp` — that is stated plainly in §7 above —
and the TTL is what bounds the exposure. Revisit if a form ever carries
something that would matter in a leaked link.
