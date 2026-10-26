/**
 * A real MCP client talking to the real Worker, through the real OAuth layer.
 *
 * The transport's `fetch` is pointed at the Worker's own default export inside
 * workerd, so every test below exercises the whole path: HTTP, `OAuthProvider`'s
 * bearer-token validation, `createMcpHandler`'s Streamable HTTP transport,
 * JSON-RPC framing, `inputSchema` validation, the tool handler, the
 * SQLite-backed Durable Object and the ASSETS binding. Nothing is stubbed
 * except the two calls that leave the account entirely (cloudflareaccess.com), which is
 * the point — the parts of this build most likely to be wrong are the platform
 * seams, and a mock of a seam proves nothing about the seam.
 *
 * Build step 7 replaced the unguessable base path with GitHub OAuth, so the
 * token now has to be EARNED rather than assumed. `authorize()` below walks the
 * whole grant: dynamic client registration → `/authorize` → the Access bounce →
 * `/callback` → `/token`. That is deliberately not shortcut through
 * `getOAuthApi()`: the seam under test is exactly the one a claude.ai custom
 * connector will traverse.
 */

import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";

/** Plain `/mcp` now — the path stopped being a capability in build step 7. */
export const MCP_URL = new URL("http://localhost/mcp");

/**
 * The identity Access asserts. An email now, not a GitHub login.
 *
 * It no longer has to match anything in wrangler.jsonc: there is no allowlist
 * in the Worker any more, because the Cloudflare Access policy refuses an
 * unlisted user at its own login page and never redirects back. Any address
 * the stub asserts therefore completes the flow — which is exactly the
 * behaviour under test. This one is a real Tech Team member for realism.
 */
export const ALLOWED_LOGIN = "jakub@365finance.co.uk";

/** Must match wrangler.jsonc's `vars` — the Worker reads them from there. */
const ACCESS_CLIENT_ID =
  "3030004f67ef659a855c849396749d7810760e0fa50acca033d4562bc752c4f2";
const ACCESS_ISSUER = `https://365-finance.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${ACCESS_CLIENT_ID}`;

/** The MCP client's own redirect target. Never dialled — only matched. */
const CLIENT_REDIRECT = "http://localhost/oauth/callback";

export type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/* -------------------------------------------------------------------------- */
/* the Cloudflare Access stub                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `@cloudflare/vitest-plugin` 1.1.0 exposes no `fetchMock`, but its own docs
 * note that the `main` worker runs in the same isolate as the tests, so a
 * global stub applies to it too. That is the whole mechanism: replace
 * `globalThis.fetch`, answer the two cloudflareaccess.com URLs, delegate
 * everything else to the real one. `SELF.fetch` is a Fetcher binding and is
 * untouched.
 */
/** Captured once, at module load, so re-stubbing never wraps a previous stub. */
const realFetch = globalThis.fetch;

/**
 * A real RS256 keypair, generated once per isolate.
 *
 * The handler verifies the ID token's signature against the JWKS it fetches,
 * so a stub that returned an unsigned or hand-assembled token would test
 * nothing: every sign-in would fail for the same reason a forged one does.
 * Signing properly here is what makes "a valid token is accepted" and "a
 * tampered one is not" two different outcomes.
 *
 * One keypair per isolate matters: `createRemoteJWKSet` caches inside the
 * Worker, so a second keypair would be verified against the first one's JWKS.
 */
let accessKeys: Promise<{ privateKey: CryptoKey; jwks: unknown }> | undefined;

function keysForAccess(): Promise<{ privateKey: CryptoKey; jwks: unknown }> {
  accessKeys ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    return {
      privateKey,
      jwks: { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] },
    };
  })();
  return accessKeys;
}

/** An ID token shaped exactly as Access issues one, signed with the test key. */
export async function idTokenFor(
  email: string,
  overrides: { issuer?: string; audience?: string } = {},
): Promise<string> {
  const { privateKey } = await keysForAccess();
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? ACCESS_ISSUER)
    .setAudience(overrides.audience ?? ACCESS_CLIENT_ID)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/**
 * Stubs Access's token and JWKS endpoints.
 *
 * `token` takes an optional override so a test can hand back a token that is
 * correctly signed but wrong in a way only verification catches.
 */
export function stubAccess(
  email: string,
  overrides: { issuer?: string; audience?: string } = {},
): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${ACCESS_ISSUER}/token`)) {
      return Response.json({
        id_token: await idTokenFor(email, overrides),
        token_type: "bearer",
      });
    }
    if (url.startsWith(`${ACCESS_ISSUER}/jwks`)) {
      return Response.json((await keysForAccess()).jwks);
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
 * Walks a full authorization for `login`, stubbing Cloudflare Access.
 *
 * Returns the raw callback response rather than throwing on refusal, because
 * the refusal IS the thing several tests assert on.
 */
export async function authorize(
  login: string = ALLOWED_LOGIN,
  overrides: { issuer?: string; audience?: string } = {},
): Promise<AuthorizeOutcome> {
  stubAccess(login, overrides);
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

  // What the browser would carry back: the state Access echoes, and the
  // session cookie that proves it is the same browser.
  const upstream = new URL(bounce.headers.get("Location") ?? "");
  const stateToken = upstream.searchParams.get("state") ?? "";
  const cookie = (bounce.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

  const callback = await hosted(
    `http://localhost/callback?code=cf_code&state=${encodeURIComponent(stateToken)}`,
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

/**
 * What the client DECLARES, which is what decides its carrier.
 *
 * Default: nothing, matching the SDK client's own default and the "says
 * nothing" case the server treats as inline.
 */
export type ConnectOptions = {
  name?: string;
  capabilities?: Record<string, unknown>;
};

export async function connect(options: ConnectOptions = {}): Promise<{
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}> {
  const accessToken = await tokenForTests();
  const transport = new StreamableHTTPClientTransport(MCP_URL, { fetch: mcpFetch(accessToken) });
  const client = new Client(
    { name: options.name ?? "mcp-questionnaire-tests", version: "0.0.0" },
    options.capabilities ? { capabilities: options.capabilities } : undefined,
  );
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

/**
 * A `tools/call` on the wire, carrying the per-request `_meta` envelope
 * (protocol revision 2026-07-28).
 *
 * The SDK client cannot stand in for this: it sends no envelope at all, so a
 * test built on it can only ever exercise the "client said nothing" path. What
 * decides a form's carrier is what the client DECLARED, and the only honest way
 * to test that is to declare it the way a real client does — the key names
 * below are the ones measured off Claude Code 2.1.178 on 2026-09-09.
 */
export async function rawCall(
  name: string,
  args: Record<string, unknown>,
  declaration: {
    clientName?: string;
    capabilities?: Record<string, unknown>;
    /** What dialled the Worker. This is what decides the carrier — see needsLink. */
    userAgent?: string;
  } = {},
): Promise<ToolResult> {
  const accessToken = await tokenForTests();
  const envelope: Record<string, unknown> = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: declaration.clientName ?? "test-client",
      version: "0.0.0",
    },
  };
  // Required on every 2026-07-28 request: omitting it is a -32602 before the
  // handler is ever reached. Default to declaring nothing in particular.
  envelope["io.modelcontextprotocol/clientCapabilities"] = declaration.capabilities ?? {};

  const response = await SELF.fetch(
    new Request(MCP_URL.href, {
      method: "POST",
      headers: {
        Host: MCP_URL.host,
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // Required by the 2026-07-28 transport: the headers and the body must
        // agree on both the method and the tool before the server will look at
        // either. The transport checks this before dispatch, so a mismatch is a
        // -32020 rather than a tool error.
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
        ...(declaration.userAgent ? { "User-Agent": declaration.userAgent } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, _meta: envelope },
      }),
    }) as never,
  );

  const body = await response.text();
  // Streamable HTTP may answer as JSON or as a one-event SSE stream.
  const json =
    body.startsWith("event:") || body.startsWith("data:")
      ? JSON.parse(body.split("data: ")[1] ?? "{}")
      : JSON.parse(body);
  return (json.result ?? json) as ToolResult;
}

/** The text of the first content item — what actually lands in model context. */
export function firstText(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}
