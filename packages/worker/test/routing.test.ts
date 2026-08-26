/**
 * Routing under `OAuthProvider` (§3, build step 7).
 *
 * These replace the base-path tests. The worst deploy mistake this project can
 * make used to be "serving MCP at a guessable path"; it is now "serving MCP to
 * an unauthenticated caller", so that is what these assert — including the
 * exact 401 shape, because the MCP authorization spec makes the
 * `WWW-Authenticate` challenge and the RFC 9728 metadata document the entire
 * discovery mechanism. A client that cannot find the authorization server
 * cannot start the flow, and a 401 with no challenge is indistinguishable from
 * a broken server.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const get = (path: string, init?: RequestInit) =>
  SELF.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { Host: "localhost", ...((init?.headers as Record<string, string>) ?? {}) },
    }) as never,
  );

describe("the unprotected surface", () => {
  it("404s the root — the renderer bundle is not a public page", async () => {
    const response = await get("/");
    expect(response.status).toBe(404);
  });

  it("404s index.html — assets are reachable only through resources/read", async () => {
    const response = await get("/index.html");
    expect(response.status).toBe(404);
  });

  it("404s anything the OAuth flow does not own", async () => {
    for (const path of ["/authorize/extra", "/callback/extra", "/admin"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it("treats /mcp as a PREFIX, so near misses are protected, not public", async () => {
    // `apiRoute` matches by prefix, so `/mcp/anything` is an API request and
    // gets the 401 before the MCP handler could 404 it. That ordering is the
    // right one — an unauthenticated caller learns nothing about which
    // sub-paths exist — and it is asserted so a future router change cannot
    // silently invert it.
    for (const path of ["/mcp/", "/mcp/extra"]) {
      const response = await get(path);
      expect(response.status, path).toBe(401);
    }
  });
});

describe("/mcp without a token", () => {
  it("401s with the Bearer challenge the MCP auth spec requires", async () => {
    const response = await get("/mcp", { method: "POST" });
    expect(response.status).toBe(401);

    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    // RFC 9728 §5.1 — the challenge names where the resource metadata lives,
    // and the path-suffixed form is what identifies THIS resource (`/mcp`).
    expect(challenge).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("401s a garbage bearer token too, and says why", async () => {
    const response = await get("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate") ?? "").toContain("invalid_token");
  });
});

describe("discovery documents", () => {
  it("publishes protected resource metadata for /mcp (RFC 9728)", async () => {
    const response = await get("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource?: string;
      authorization_servers?: string[];
    };
    expect(body.resource).toBe("http://localhost/mcp");
    expect(body.authorization_servers).toContain("http://localhost");
  });

  it("publishes authorization server metadata with DCR advertised (RFC 8414)", async () => {
    const response = await get("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authorization_endpoint).toBe("http://localhost/authorize");
    expect(body.token_endpoint).toBe("http://localhost/token");
    // Load-bearing: claude.ai custom connectors and Claude Code both register
    // themselves. No registration endpoint, no connector.
    expect(body.registration_endpoint).toBe("http://localhost/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});
