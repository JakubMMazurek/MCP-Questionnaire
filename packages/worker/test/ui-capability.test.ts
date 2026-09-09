/**
 * Which carrier a client gets, and why.
 *
 * The two failures are not symmetric, and these tests are written around that.
 * A link where a form would have rendered tells the model to hand over a URL
 * while the form sits on screen above it — observed in Cowork on 2026-09-09,
 * from a rule that read a missing `extensions` map as "cannot render". An
 * inline stub where nothing renders is only the status quo, with get_form_link
 * one call away. So a link needs POSITIVE evidence and everything else renders.
 *
 * Every declaration here was measured on the wire, not invented.
 */

import { describe, expect, it } from "vitest";
import {
  clientFingerprint,
  needsLink,
  rendersInline,
  UI_EXTENSION_ID,
} from "../src/ui-capability.js";

const CAPS = "io.modelcontextprotocol/clientCapabilities";
const INFO = "io.modelcontextprotocol/clientInfo";

/**
 * The two clients that matter, measured on the wire 2026-09-09.
 *
 * They are identical in everything they DECLARE. One renders the form inline
 * and one cannot, and the only thing that separates them is who dialled the
 * Worker — which is why the rule is a User-Agent heuristic and says so.
 */
const claudeCode = {
  envelope: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    [INFO]: { name: "claude-code", version: "2.1.260" },
    [CAPS]: { roots: {}, elicitation: {} },
  },
  userAgent: "claude-code/2.1.260 (claude-desktop; external, cli)",
};

/**
 * Cowork in the DESKTOP app — where the `Claude-User` sample was taken.
 *
 * Cowork on the web was observed rendering inline too, on an earlier build that
 * did not yet log the User-Agent, so its header is inferred rather than
 * measured: both dial the Worker from Anthropic's infrastructure rather than
 * from the user's machine. The rule does not rest on that inference — anything
 * whose UA is not a local `claude-code/…` renders inline, web Cowork and
 * claude.ai chat included, measured or not.
 */
const cowork = {
  envelope: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    [INFO]: { name: "claude-code", version: "2.1.266" },
    [CAPS]: { roots: {}, elicitation: {} },
  },
  userAgent: "Claude-User",
};

/** A host that supports MCP Apps declares the extension. */
const appsHost = {
  envelope: { [CAPS]: { extensions: { [UI_EXTENSION_ID]: {} } } },
};

describe("the extension identifier", () => {
  it("is the one ext-apps publishes", async () => {
    // The Worker inlines the constant rather than depending on ext-apps. If the
    // package ever changes it, this fails here rather than silently in prod.
    const extApps = await import("@modelcontextprotocol/ext-apps/server");
    expect(UI_EXTENSION_ID).toBe(extApps.EXTENSION_ID);
  });
});

describe("who gets a link", () => {
  it("hands one to a locally-run Claude Code", () => {
    expect(needsLink(claudeCode)).toBe(true);
  });

  /**
   * The regression this rule was rewritten for. Cowork declares exactly what
   * Claude Code declares, and renders the form anyway; the previous rule read
   * the missing extensions map as "cannot render" and told the model to hand
   * over a URL while the form sat on screen above it.
   */
  it("does not hand one to Cowork, which declares the same and renders", () => {
    expect(needsLink(cowork)).toBe(false);
  });

  it("does not hand one to a client that says nothing at all", () => {
    expect(needsLink({})).toBe(false);
    expect(needsLink({ userAgent: "some-other-client/1.0" })).toBe(false);
  });

  it("stops handing one over the moment Claude Code declares MCP Apps", () => {
    const futureCode = {
      ...claudeCode,
      envelope: { ...claudeCode.envelope, [CAPS]: { extensions: { [UI_EXTENSION_ID]: {} } } },
    };
    // Two conditions, and the declaration outranks the header: the day this
    // client can render, it renders, without anyone editing a regex.
    expect(needsLink(futureCode)).toBe(false);
  });
});

describe("reading the verdict", () => {
  it("says no for a client that declared capabilities without it", () => {
    expect(rendersInline(claudeCode)).toBe(false);
    // Note what this does NOT decide on its own — Cowork reads the same way
    // and renders regardless. See `needsLink`.
    expect(rendersInline(cowork)).toBe(false);
  });

  it("says yes for a client that declared it", () => {
    expect(rendersInline(appsHost)).toBe(true);
  });

  it("says nothing for a client that declared nothing", () => {
    expect(rendersInline({})).toBeNull();
    expect(rendersInline({ envelope: {} })).toBeNull();
    expect(rendersInline({ envelope: { [CAPS]: undefined } })).toBeNull();
  });

  it("reads the envelope's namespaced key, not a bare one", () => {
    // The bug this pins: reading `clientCapabilities` off the envelope finds
    // nothing, and a client that declared plenty reports as undeclared.
    expect(rendersInline({ envelope: { clientCapabilities: { roots: {} } } })).toBeNull();
    expect(rendersInline(claudeCode)).toBe(false);
  });

  it("prefers the per-request envelope over the handshake", () => {
    const mixed = {
      envelope: { [CAPS]: { extensions: { [UI_EXTENSION_ID]: {} } } },
      handshake: { roots: {} },
    };
    expect(rendersInline(mixed)).toBe(true);
  });

  it("falls back to the handshake on a connection with no envelope", () => {
    expect(rendersInline({ handshake: { extensions: { [UI_EXTENSION_ID]: {} } } })).toBe(true);
    expect(rendersInline({ handshake: { roots: {} } })).toBe(false);
  });
});

describe("the log line", () => {
  it("names the client and the verdict", () => {
    expect(clientFingerprint(claudeCode)).toContain("claude-code");
    // The line records the DECISION and the declaration separately, because
    // reading one as the other is the mistake that shipped.
    expect(clientFingerprint(claudeCode)).toContain("link");
    expect(clientFingerprint(claudeCode)).toContain("ext=no");
    expect(clientFingerprint(cowork)).toContain("inline");
    expect(clientFingerprint(cowork)).toContain("ext=no");
    expect(clientFingerprint(appsHost)).toContain("ext=yes");
    expect(clientFingerprint({})).toContain("ext=undeclared");
  });

  it("cannot carry anything but a sanitised identity", () => {
    const hostile = {
      envelope: { [INFO]: { name: 'x"}\n{"event":"forged' }, [CAPS]: { roots: {} } },
    };
    const line = clientFingerprint(hostile);
    expect(line).not.toContain('"');
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(180);
  });
});
