/**
 * The GitHub authorization flow — OAuthProvider's `defaultHandler` (§3, step 7).
 *
 * OAuthProvider owns `/token`, `/register` and both `.well-known` documents and
 * mints its OWN tokens for MCP clients. This handler owns only the two hops
 * that are specific to the upstream identity provider:
 *
 *   GET /authorize  parse the MCP client's OAuth request, stash it, bounce the
 *                   browser to GitHub
 *   GET /callback   exchange GitHub's code, read the login, CHECK THE
 *                   ALLOWLIST, and only then complete the authorization
 *
 * Everything else 404s, `/` included — the renderer bundle is not a public page
 * (`run_worker_first: true`), and it never was.
 *
 * Deliberate departures from Cloudflare's remote-mcp-github-oauth demo:
 *
 * - **No approval dialog.** The demo renders a consent screen and remembers
 *   approved clients in a signed cookie. Here the grant is gated on an
 *   allowlist of named humans, so the dialog would ask the one person who is
 *   allowed in whether they meant it, immediately after GitHub asked them the
 *   same question. GitHub's own consent screen is the consent screen.
 * - **No Hono, no Octokit.** Two routes and one `GET /user` do not need a
 *   router and an API client, and §8's "everything inlined" instinct applies to
 *   the server too.
 * - **The GitHub access token is not kept.** The demo puts it in `props`; this
 *   server never calls GitHub again after the callback, so keeping it would
 *   store a credential at rest for no purpose. `props` is `{ login }`.
 *
 * What is NOT dropped is the CSRF story, because it is the one part of this
 * flow that is load-bearing. GitHub hands the `state` value back to whoever
 * follows the callback URL, so `state` alone proves only "this server started
 * SOME flow". Every authorize mints a one-time state token (stored in
 * `OAUTH_KV`, 10-minute TTL) AND a session token set as a host-locked cookie;
 * the callback requires both to match before it will spend the code. An
 * attacker who replays a victim's callback URL has the state but not the
 * cookie, and gets nothing.
 */

import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { ALLOWLIST_UNSET, isAllowedLogin, parseAllowlist } from "./allowlist.js";
import type { AuthProps, WorkerEnv } from "./env.js";
import { logConfigError, logEvent } from "./log.js";

/* -------------------------------------------------------------------------- */
/* upstream constants                                                         */
/* -------------------------------------------------------------------------- */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * The narrowest scope GitHub offers that still returns `login` from
 * `GET /user`. Not `read:user` (the demo's choice): the default no-scope token
 * already reads a public profile, and this flow needs the login and nothing
 * else. An empty `scope` parameter is what GitHub documents for that.
 */
const GITHUB_SCOPE = "";

/** GitHub's API rejects requests without one. */
const USER_AGENT = "mcp-questionnaire (Cloudflare Worker)";

/* -------------------------------------------------------------------------- */
/* one-time state, bound to the browser session                               */
/* -------------------------------------------------------------------------- */

/** Namespaced away from OAuthProvider's own `token:` / `grant:` / `client:` keys. */
const STATE_KEY_PREFIX = "github_state:";
const STATE_TTL_SECONDS = 600;

/**
 * `__Host-` locks the cookie to this exact origin with `Path=/` and no
 * `Domain`, which is what makes "same browser that started the flow" mean
 * something. It requires `Secure`; browsers treat `http://localhost` as a
 * secure context, so local development still works.
 */
const SESSION_COOKIE = "__Host-mcpq-oauth-session";

type StoredState = { request: AuthRequest; session: string };

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const setSessionCookie = (value: string) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_TTL_SECONDS}`;

const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/**
 * Constant-time-ish comparison for the session token.
 *
 * Both values are 256-bit random hex the attacker cannot influence, so this is
 * belt-and-braces rather than a real timing defence — but a plain `===` on a
 * secret is the kind of thing that is right until the secret changes shape.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* pages                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Self-contained HTML, no external anything — the same §8 rule the renderer
 * bundle lives under, applied to the two pages a human ever sees here. Colours
 * come from `color-scheme` plus system defaults rather than a palette, because
 * an error page that fights the OS theme is worse than a plain one.
 */
function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>` +
      `:root{color-scheme:light dark}` +
      `body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;` +
      `margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem}` +
      `main{max-width:34rem}h1{font-size:1.3rem;margin:0 0 .75rem}` +
      `p{margin:0 0 .75rem}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.9em}` +
      `</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

/** Minimal HTML escaping — the only value interpolated is a GitHub login. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * The refusal page.
 *
 * It names the visitor's OWN login and nothing else: no other allowlisted
 * name, no client id, no token, no hint about who is on the list. Telling
 * someone which account they are signed in as is the difference between "this
 * is broken" and "you are signed into the wrong GitHub account", which is the
 * single most likely cause — and it is information they already had.
 */
function refusalPage(login: string): Response {
  return page(
    "Not authorized",
    `<p>You are signed in to GitHub as <code>${escapeHtml(login)}</code>, which is not on this server's allowlist.</p>` +
      `<p>Nothing was granted and no token was issued. If you should have access, ask the owner of this deployment to add your GitHub login to <code>GITHUB_ALLOWED_USERS</code> and redeploy.</p>`,
    403,
  );
}

/* -------------------------------------------------------------------------- */
/* GET /authorize                                                             */
/* -------------------------------------------------------------------------- */

async function handleAuthorize(request: Request, env: WorkerEnv): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    /**
     * The library's contract: no `redirectUri` means client/redirect
     * validation never passed, so redirecting would send an error to an
     * unvalidated URL. Render locally instead.
     */
    if (!error.redirectUri) {
      return page("Authorization request rejected", `<p>${escapeHtml(error.description)}</p>`, 400);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.href, 302);
  }

  // Fail closed BEFORE bouncing to GitHub: with no allowlist nobody can ever
  // complete this flow, so sending the user to GitHub first would only waste
  // their consent on a grant that cannot be issued.
  if (parseAllowlist(env.GITHUB_ALLOWED_USERS).length === 0) {
    logConfigError(ALLOWLIST_UNSET);
    return page(
      "Not authorized",
      "<p>This server has no authorized users configured, so no authorization can be granted.</p>",
      403,
    );
  }

  const stateToken = randomToken();
  const session = randomToken();
  const stored: StoredState = { request: oauthRequest, session };
  await env.OAUTH_KV.put(`${STATE_KEY_PREFIX}${stateToken}`, JSON.stringify(stored), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const upstream = new URL(GITHUB_AUTHORIZE_URL);
  upstream.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  upstream.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  upstream.searchParams.set("scope", GITHUB_SCOPE);
  upstream.searchParams.set("state", stateToken);

  logEvent({ event: "oauth_authorize_started" });
  return new Response(null, {
    status: 302,
    headers: {
      Location: upstream.href,
      "Set-Cookie": setSessionCookie(session),
      "Cache-Control": "no-store",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* GET /callback                                                              */
/* -------------------------------------------------------------------------- */

/** Exchanges GitHub's `code` for an access token. Returns null on any failure. */
async function exchangeCode(
  env: WorkerEnv,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!response.ok) return null;
  // GitHub answers 200 with `{ error: ... }` on a bad code, so the body decides.
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" && body.access_token.length > 0
    ? body.access_token
    : null;
}

/** Reads the authenticated user's login. Returns null on any failure. */
async function fetchLogin(accessToken: string): Promise<string | null> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { login?: unknown };
  return typeof body.login === "string" && body.login.length > 0 ? body.login : null;
}

async function handleCallback(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const headers = new Headers({ "Set-Cookie": clearSessionCookie() });

  if (!code || !stateToken) {
    return withHeaders(
      page("Sign-in failed", "<p>GitHub did not return an authorization code.</p>", 400),
      headers,
    );
  }

  const key = `${STATE_KEY_PREFIX}${stateToken}`;
  const stored = await env.OAUTH_KV.get<StoredState>(key, { type: "json" });
  // One-time use: spend the state whether or not the rest succeeds, so a
  // replay of this exact URL cannot get a second try.
  if (stored) await env.OAUTH_KV.delete(key);

  const session = readCookie(request, SESSION_COOKIE);
  if (!stored || !session || !tokensMatch(stored.session, session)) {
    // Both branches answer identically on purpose: "unknown state" and "wrong
    // browser" are the same event to anyone probing this endpoint.
    logEvent({ event: "oauth_callback_rejected", code: "state" });
    return withHeaders(
      page(
        "Sign-in failed",
        "<p>This sign-in link is expired, already used, or was not started in this browser. Start again from your MCP client.</p>",
        400,
      ),
      headers,
    );
  }

  const accessToken = await exchangeCode(env, code, new URL("/callback", request.url).href);
  if (!accessToken) {
    logEvent({ event: "oauth_callback_rejected", code: "code_exchange" });
    return withHeaders(
      page("Sign-in failed", "<p>GitHub rejected the authorization code.</p>", 400),
      headers,
    );
  }

  const login = await fetchLogin(accessToken);
  if (!login) {
    logEvent({ event: "oauth_callback_rejected", code: "user_lookup" });
    return withHeaders(
      page("Sign-in failed", "<p>Could not read your GitHub account.</p>", 502),
      headers,
    );
  }

  if (!isAllowedLogin(login, env.GITHUB_ALLOWED_USERS)) {
    // Counted, never named: §3's no-payloads rule covers identities too, and a
    // refused login in a retained log is exactly the kind of personal data
    // this Worker has no reason to keep.
    logEvent({ event: "oauth_login_refused" });
    return withHeaders(refusalPage(login), headers);
  }

  const props: AuthProps = { login };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.request,
    userId: login,
    metadata: { label: login },
    scope: stored.request.scope,
    props,
  });

  logEvent({ event: "oauth_login_granted" });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

function withHeaders(response: Response, extra: Headers): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of extra) merged.append(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

/* -------------------------------------------------------------------------- */
/* the handler                                                                */
/* -------------------------------------------------------------------------- */

export const githubHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }

    // Everything else, `/` included. Nothing about this deployment beyond the
    // OAuth metadata OAuthProvider publishes is discoverable by fetching it.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
