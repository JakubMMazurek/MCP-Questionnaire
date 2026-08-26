/**
 * A real MCP client talking to the real Worker, through the real OAuth layer.
 *
 * The transport's `fetch` is pointed at the Worker's own default export inside
 * workerd, so every test below exercises the whole path: HTTP, `OAuthProvider`'s
 * bearer-token validation, `createMcpHandler`'s Streamable HTTP transport,
 * JSON-RPC framing, `inputSchema` validation, the tool handler, the
 * SQLite-backed Durable Object and the ASSETS binding. Nothing is stubbed
 * except the two calls that leave the account entirely (github.com), which is
 * the point — the parts of this build most likely to be wrong are the platform
 * seams, and a mock of a seam proves nothing about the seam.
 *
 * Build step 7 replaced the unguessable base path with GitHub OAuth, so the
 * token now has to be EARNED rather than assumed. `authorize()` below walks the
 * whole grant: dynamic client registration → `/authorize` → the GitHub bounce →
 * `/callback` → `/token`. That is deliberately not shortcut through
 * `getOAuthApi()`: the seam under test is exactly the one a claude.ai custom
 * connector will traverse.
 */

import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

/** Plain `/mcp` now — the path stopped being a capability in build step 7. */
export const MCP_URL = new URL("http://localhost/mcp");

/** Must be on wrangler.jsonc's `vars.GITHUB_ALLOWED_USERS`, case aside. */
export const ALLOWED_LOGIN = "JakubMMazurek";

/** The MCP client's own redirect target. Never dialled — only matched. */
const CLIENT_REDIRECT = "http://localhost/oauth/callback";

export type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/* -------------------------------------------------------------------------- */
/* the github stub                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `@cloudflare/vitest-plugin` 1.1.0 exposes no `fetchMock`, but its own docs
 * note that the `main` worker runs in the same isolate as the tests, so a
 * global stub applies to it too. That is the whole mechanism: replace
 * `globalThis.fetch`, answer the two github.com URLs, delegate everything else
 * to the real one. `SELF.fetch` is a Fetcher binding and is untouched.
 */
/** Captured once, at module load, so re-stubbing never wraps a previous stub. */
const realFetch = globalThis.fetch;

export function stubGitHub(login: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_test_token", token_type: "bearer" });
    }
    if (url.startsWith("https://api.github.com/user")) {
      return Response.json({ login, id: 1 });
    }
    return realFetch(input as never, init as never);
  });
}

/* -------------------------------------------------------------------------- */
/* PKCE                                                                       */
/* -------------------------------------------------------------------------- */

const base64Url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  // S256 only: `allowPlainPKCE` defaults to false, which is the right default.
  return { verifier, challenge: base64Url(digest) };
}

/* -------------------------------------------------------------------------- */
/* the flow                                                                   */
/* -------------------------------------------------------------------------- */

/** Every request through the Worker needs an explicit Host — see `mcpFetch`. */
const hosted = (url: string, init?: RequestInit) =>
  SELF.fetch(
    new Request(url, {
      ...init,
      headers: { Host: "localhost", ...((init?.headers as Record<string, string>) ?? {}) },
    }) as never,
  );

/** RFC 7591 dynamic client registration — the path claude.ai actually takes. */
export async function registerClient(): Promise<string> {
  const response = await hosted("http://localhost/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp-questionnaire-tests",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status}`);
  const body = (await response.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("register returned no client_id");
  return body.client_id;
}

export type AuthorizeOutcome = {
  /** The `/callback` response — 302 on success, 403 when the login is refused. */
  callback: Response;
  /** Present only when the grant completed. */
  accessToken?: string;
};

/**
 * Walks a full authorization for `login`, stubbing github.com.
 *
 * Returns the raw callback response rather than throwing on refusal, because
 * the refusal IS the thing several tests assert on.
 */
export async function authorize(login: string = ALLOWED_LOGIN): Promise<AuthorizeOutcome> {
  stubGitHub(login);
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();

  const authorizeUrl = new URL("http://localhost/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  authorizeUrl.searchParams.set("state", "client-state");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const bounce = await hosted(authorizeUrl.href, { redirect: "manual" });
  if (bounce.status !== 302) throw new Error(`/authorize returned ${bounce.status}`);

  // What the browser would carry back: the state GitHub echoes, and the
  // session cookie that proves it is the same browser.
  const upstream = new URL(bounce.headers.get("Location") ?? "");
  const stateToken = upstream.searchParams.get("state") ?? "";
  const cookie = (bounce.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

  const callback = await hosted(
    `http://localhost/callback?code=gh_code&state=${encodeURIComponent(stateToken)}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  if (callback.status !== 302) return { callback };

  const redirect = new URL(callback.headers.get("Location") ?? "");
  const code = redirect.searchParams.get("code") ?? "";

  const token = await hosted("http://localhost/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!token.ok) throw new Error(`/token returned ${token.status}`);
  const body = (await token.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("/token returned no access_token");
  return { callback, accessToken: body.access_token };
}

/* -------------------------------------------------------------------------- */
/* the MCP client                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One token per isolate. Minting a grant costs a DCR write, a KV round trip and
 * an SHA-256, and every test in the suite wants the same identity — so it is
 * cached rather than re-earned ~50 times. Tests that care about the AUTH layer
 * itself call `authorize()` directly and get a fresh one.
 */
let cachedToken: Promise<string> | undefined;

function tokenForTests(): Promise<string> {
  cachedToken ??= authorize().then(({ accessToken }) => {
    if (!accessToken) throw new Error("harness could not obtain an access token");
    return accessToken;
  });
  return cachedToken;
}

/**
 * `SELF.fetch` does not synthesise a `Host` header, and the handler validates
 * it (that is `allowedHostnames`' localhost default doing its job), so it is
 * set explicitly here. This is a property of the test harness, not of the
 * Worker: a real HTTP client always sends one.
 */
function mcpFetch(accessToken: string) {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input as never, init as never);
    const headers = new Headers(request.headers);
    headers.set("Host", MCP_URL.host);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return SELF.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      }) as never,
    );
  }) as never;
}

export async function connect(): Promise<{
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}> {
  const accessToken = await tokenForTests();
  const transport = new StreamableHTTPClientTransport(MCP_URL, { fetch: mcpFetch(accessToken) });
  const client = new Client({ name: "mcp-questionnaire-tests", version: "0.0.0" });
  await client.connect(transport);

  return {
    client,
    /**
     * `tools/call` without the SDK's result-schema narrowing, because these
     * tests assert on `isError` and on `structuredContent` shapes the SDK's
     * default schema would strip.
     */
    call: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    close: async () => {
      await client.close();
    },
  };
}

/** The text of the first content item — what actually lands in model context. */
export function firstText(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}
