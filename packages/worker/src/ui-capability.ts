/**
 * Can this client render the form, or does it need a link?
 *
 * The renderer reaches a person two ways now (PROPOSAL-standalone-route.md):
 * mounted as `ui://forms/renderer` by a host that supports MCP Apps, or opened
 * as a page from a signed URL. Which one to use is not a judgement call for the
 * model — the server can see what the client declared, so the server decides.
 *
 * The extension identifier is `io.modelcontextprotocol/ui`, and support is
 * advertised under `clientCapabilities.extensions` (ext-apps 1.7.5 exports the
 * same constant and a `getUiCapability` helper that reads exactly this key; the
 * three lines are inlined rather than adding the dependency to the Worker, and
 * the constant is asserted against the package in the tests).
 *
 * The verdict is deliberately THREE-valued, because "the client said it cannot"
 * and "the client said nothing" are different claims and only one of them is
 * evidence:
 *
 *   true   — declared the extension. Render inline; this is chat, Cowork,
 *            Desktop chat, mobile.
 *   false  — declared its capabilities, and this was not among them.
 *   null   — said nothing either way, or spoke a protocol revision that
 *            carries no envelope. Unknown, and unknown must behave exactly as
 *            this server behaved before it could tell the difference.
 */

/**
 * A locally-run Claude Code, by its User-Agent.
 *
 * MEASURED 2026-09-09, and the measurement overturned the previous rule. Claude
 * Code and Cowork are indistinguishable in everything they DECLARE — both send
 * `clientInfo.name: "claude-code"`, both declare `{ roots, elicitation }` and
 * no `extensions` map, both send the same envelope keys. One of them renders
 * the form inline and one cannot. The only thing that differs is who is dialling
 * the Worker:
 *
 *   Claude Code (desktop)  ua: `claude-code/2.1.260 (claude-desktop; …)`
 *   Cowork (web)           ua: `Claude-User`
 *
 * `Claude-User` is Anthropic's server-side fetcher — chat, Cowork and mobile all
 * reach an MCP server through it, and all of them mount the renderer. Claude
 * Code connects directly from the user's machine and mounts nothing.
 *
 * This is a heuristic on a header, and it is written down as one. What keeps it
 * honest is the direction it fails in: it is the POSITIVE evidence required
 * before a link is sent, so anything unrecognised keeps rendering inline.
 */
export const LOCAL_CLAUDE_CODE_UA = /^claude-code\//i;

/** ext-apps `EXTENSION_ID`. Asserted against the package in the tests. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

type Capabilities = { extensions?: Record<string, unknown> } | undefined | null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Reads one capabilities object. Null only when there is no such object.
 *
 * A capabilities object with no `extensions` map counts as a NO, not as
 * silence, and that is the spec's own reading: "Extensions are always opt-in: a
 * client only uses an extension if both client and server declare support in
 * the `extensions` field of their capabilities." A client that listed what it
 * supports and did not list this has answered the question.
 *
 * Measured, not assumed: Claude Code 2.1.178 declares `{ roots, elicitation }`
 * and no `extensions` at all, which is exactly the client this route exists
 * for. Treating that as silence would have left it rendering nothing forever.
 */
function verdictOf(capabilities: Capabilities): boolean | null {
  const object = record(capabilities);
  if (!object) return null;
  return UI_EXTENSION_ID in (record(object.extensions) ?? {});
}

/**
 * The per-request `_meta` envelope (protocol revision 2026-07-28) carries the
 * client's capabilities on every request; a 2025-era connection declares them
 * once at `initialize` and the server keeps them. Both are read, the
 * per-request one first, because a stateless handler serves each request on a
 * fresh instance and the envelope is the only source that is certainly about
 * THIS request.
 */
/**
 * Envelope keys are NAMESPACED on the wire — `io.modelcontextprotocol/…` — not
 * bare. Measured against Claude Code 2.1.178, which sends
 * `protocolVersion`, `clientInfo` and `clientCapabilities` under that prefix;
 * reading the bare name finds nothing and reports "undeclared" for a client
 * that declared plenty.
 */
const ENVELOPE_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const ENVELOPE_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

export function rendersInline(sources: {
  envelope?: unknown;
  handshake?: unknown;
}): boolean | null {
  const fromEnvelope = verdictOf(record(record(sources.envelope)?.[ENVELOPE_CAPABILITIES]));
  if (fromEnvelope !== null) return fromEnvelope;
  return verdictOf(record(sources.handshake));
}

/**
 * A closed-vocabulary fingerprint for the log (§3 — no payloads, ever).
 *
 * Client software identity is not user data, but it is also not a fixed
 * vocabulary, so it is reduced here to a shape that cannot carry anything else:
 * lowercased, non-alphanumerics collapsed, truncated. What it answers is the
 * only question worth asking of the logs — which clients are getting links, and
 * whether that matches what they can actually do.
 */
/**
 * Should this client be handed a link instead of a form?
 *
 * TWO conditions, and both are required:
 *
 *  1. It did not declare MCP Apps. If a future Claude Code gains the extension
 *     and says so, this flips back to inline on its own.
 *  2. It is a locally-run Claude Code by User-Agent — the positive evidence.
 *
 * The default is inline for everything else, including every client that says
 * nothing at all, because the two failures are not symmetric: a link where a
 * form would have rendered tells the model to hand over a URL while the form
 * sits on screen above it (observed in Cowork, 2026-09-09), whereas an inline
 * stub where nothing renders is only the status quo, with get_form_link one
 * call away and skill rule 11 pointing at it.
 */
export function needsLink(sources: {
  envelope?: unknown;
  handshake?: unknown;
  userAgent?: string | null;
}): boolean {
  if (rendersInline(sources) === true) return false;
  return LOCAL_CLAUDE_CODE_UA.test(sources.userAgent ?? "");
}

export function clientFingerprint(sources: {
  envelope?: unknown;
  handshake?: unknown;
  clientInfo?: unknown;
  userAgent?: string | null;
}): string {
  const name =
    record(record(sources.envelope)?.[ENVELOPE_CLIENT_INFO])?.name ??
    record(sources.clientInfo)?.name;
  const safe =
    typeof name === "string"
      ? name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 24)
      : "unknown";
  const verdict = needsLink(sources) ? "link" : "inline";
  const declared = rendersInline(sources);
  const keys = (value: unknown) => Object.keys(record(value) ?? {}).join("+") || "none";
  const envelopeInfo = record(record(sources.envelope)?.[ENVELOPE_CLIENT_INFO]);
  const version = envelopeInfo?.version ?? record(sources.clientInfo)?.version;
  const caps =
    record(record(sources.envelope)?.[ENVELOPE_CAPABILITIES]) ?? record(sources.handshake);
  return [
    safe,
    verdict,
    `ext=${declared === null ? "undeclared" : declared ? "yes" : "no"}`,
    `v=${typeof version === "string" ? version : "?"}`,
    `caps=${keys(caps)}`,
    `info=${keys(envelopeInfo)}`,
    `ua=${(sources.userAgent ?? "none").slice(0, 40)}`,
  ]
    .join(":")
    .replace(/[^a-zA-Z0-9:+=._-]/g, "")
    .slice(0, 180);
}
