/**
 * Which carrier a client gets, and why.
 *
 * The two failures are not symmetric, and these tests are written around that.
 * A link where a form would have rendered puts a capability URL into a
 * conversation that never needed one and makes chat worse for everyone; an
 * inline stub where nothing renders is only the status quo, with get_form_link
 * one call away. So silence means inline, and only an explicit declaration that
 * does not include MCP Apps buys a link.
 *
 * The declarations here are the ones measured on the wire, not invented:
 * Claude Code 2.1.178 sends `{ roots, elicitation }` with no `extensions` map,
 * under `io.modelcontextprotocol/`-prefixed envelope keys.
 */

import { describe, expect, it } from "vitest";
import { clientFingerprint, rendersInline, UI_EXTENSION_ID } from "../src/ui-capability.js";

const CAPS = "io.modelcontextprotocol/clientCapabilities";
const INFO = "io.modelcontextprotocol/clientInfo";

/** What Claude Code actually sends (measured 2026-09-09, CLI 2.1.178). */
const claudeCode = {
  envelope: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    [INFO]: { name: "claude-code", version: "2.1.178" },
    [CAPS]: { roots: {}, elicitation: {} },
  },
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

describe("reading the verdict", () => {
  it("says no for a client that declared capabilities without it", () => {
    expect(rendersInline(claudeCode)).toBe(false);
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
    expect(clientFingerprint(claudeCode)).toContain("no-ui");
    expect(clientFingerprint(appsHost)).toContain("inline");
    expect(clientFingerprint({})).toContain("undeclared");
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
