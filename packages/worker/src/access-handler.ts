/**
 * The Cloudflare Access authorization flow — OAuthProvider's `defaultHandler`.
 *
 * Replaces the GitHub flow (2026-10-26). The shape is identical, because the
 * shape was never about GitHub: OAuthProvider owns `/token`, `/register` and
 * both `.well-known` documents and mints its OWN tokens for MCP clients, and
 * this handler owns only the two hops that are specific to the upstream
 * identity provider:
 *
 *   GET /authorize  parse the MCP client's OAuth request, stash it, bounce the
 *                   browser to Cloudflare Access
 *   GET /callback   exchange Access's code, verify the ID token, read the
 *                   email, and complete the authorization
 *
 * Everything else 404s, `/` included — the renderer bundle is not a public page
 * (`run_worker_first: true`), and it never was.
 *
 * WHY ACCESS AND NOT ENTRA DIRECTLY. The company already runs Zero Trust with
 * Microsoft Entra ID as its identity provider and a "Tech Team" policy that
 * gates the docs and platform apps. Pointing this Worker at Entra itself would
 * have meant a second app registration and a second copy of the membership
 * question. Access sits in front of Entra and answers both: it is an OIDC
 * provider in its own right ("Access for SaaS"), so this Worker federates to
 * it exactly as it used to federate to GitHub, and the Access policy decides
 * who may complete the flow.
 *
 * THERE IS NO ALLOWLIST HERE ANY MORE, and that is the point. `GITHUB_ALLOWED_
 * USERS` was twenty logins in `vars` that someone had to remember to edit.
 * The gate is now the Tech Team policy in Zero Trust: Access refuses the user
 * at its own login page and never redirects back, so a refusal costs this
 * Worker nothing and leaves no half-finished grant. A leaver loses access when
 * their Entra account is disabled, because the policy requires Entra as the
 * login method — not when someone remembers to open a pull request.
 *
 * What is NOT dropped is the CSRF story, because it is the one part of this
 * flow that is load-bearing and it is upstream-agnostic. Access hands the
 * `state` value back to whoever follows the callback URL, so `state` alone
 * proves only "this server started SOME flow". Every authorize mints a
 * one-time state token (stored in `OAUTH_KV`, 10-minute TTL) AND a session
 * token set as a host-locked cookie; the callback requires both to match
 * before it will spend the code. An attacker who replays a victim's callback
 * URL has the state but not the cookie, and gets nothing.
 */

import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthProps, WorkerEnv } from "./env.js";
import { handleFormPage } from "./form-page.js";
import { logConfigError, logEvent } from "./log.js";

/* -------------------------------------------------------------------------- */
/* upstream endpoints                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Access publishes a discovery document and the three endpoints below hang off
 * the issuer by a fixed suffix. Verified 2026-10-26 against the live document
 * for this application:
 *
 *   GET <issuer>/.well-known/openid-configuration
 *   → authorization_endpoint <issuer>/authorization
 *     token_endpoint         <issuer>/token
 *     jwks_uri               <issuer>/jwks
 *
 * Deriving them from one configured issuer beats three `vars` that have to
 * agree with each other: there is one value to get wrong instead of three, and
 * a wrong one fails loudly at the first hop. If Cloudflare ever moves them,
 * the discovery document is the source of truth and this is where to look.
 */
const authorizationUrl = (issuer: string) => `${issuer}/authorization`;
const tokenUrl = (issuer: string) => `${issuer}/token`;
const jwksUrl = (issuer: string) => `${issuer}/jwks`;

/**
 * `openid` is required by OIDC; `email` carries the identity this server
 * actually uses. `profile` and `groups` are offered by the application and
 * deliberately not requested — nothing here reads a display name or a group,
 * and a scope you do not ask for is a claim you cannot accidentally start
 * depending on.
 */
const ACCESS_SCOPE = "openid email";

const CONFIG_UNSET =
  "ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET or ACCESS_ISSUER is unset — no authorization can be granted";

/* -------------------------------------------------------------------------- */
/* one-time state, bound to the browser session                               */
/* -------------------------------------------------------------------------- */

/** Namespaced away from OAuthProvider's own `token:` / `grant:` / `client:` keys. */
const STATE_KEY_PREFIX = "access_state:";
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
 * bundle lives under, applied to the pages a human ever sees here. Colours
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/* -------------------------------------------------------------------------- */
/* the ID token                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One JWKS fetcher per issuer, cached for the isolate's life.
 *
 * `createRemoteJWKSet` does its own caching and key-rollover handling, so the
 * cost of verification is one fetch per isolate rather than one per sign-in.
 * Keyed by issuer because the type permits it to change between requests under
 * test even though production has exactly one.
 */
const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwkSetFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwkSets.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl(issuer)));
    jwkSets.set(issuer, set);
  }
  return set;
}

/**
 * Verifies the ID token and returns the email it asserts.
 *
 * The signature is checked even though the token arrived over TLS from a
 * direct, client-authenticated POST — the flow where OIDC Core §3.1.3.7 says
 * verification MAY be skipped. It is not skipped here because `jwtVerify` is
 * also what checks `iss`, `aud` and `exp`, and those three are the claims that
 * stop a token minted for some OTHER Access application being replayed at this
 * one. Getting them for free alongside a library-grade signature check is a
 * better trade than hand-rolling the three on a payload nobody verified.
 *
 * Returns null on any failure. The caller never learns which failure, and
 * neither does the visitor.
 */
async function emailFromIdToken(idToken: string, env: WorkerEnv): Promise<string | null> {
  const issuer = env.ACCESS_ISSUER;
  if (!issuer) return null;
  try {
    const { payload } = await jwtVerify(idToken, jwkSetFor(issuer), {
      issuer,
      audience: env.ACCESS_CLIENT_ID,
    });
    const email = payload.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* GET /authorize                                                             */
/* -------------------------------------------------------------------------- */

function configured(env: WorkerEnv): boolean {
  return Boolean(env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET && env.ACCESS_ISSUER);
}

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

  // Fail closed BEFORE bouncing to Access: with no client credentials the
  // callback could never spend the code, so sending the user through a
  // Microsoft sign-in first would only waste it on a grant that cannot issue.
  if (!configured(env)) {
    logConfigError(CONFIG_UNSET);
    return page(
      "Not authorized",
      "<p>This server has no identity provider configured, so no authorization can be granted.</p>",
      403,
    );
  }

  const stateToken = randomToken();
  const session = randomToken();
  const stored: StoredState = { request: oauthRequest, session };
  await env.OAUTH_KV.put(`${STATE_KEY_PREFIX}${stateToken}`, JSON.stringify(stored), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const upstream = new URL(authorizationUrl(env.ACCESS_ISSUER as string));
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("client_id", env.ACCESS_CLIENT_ID as string);
  upstream.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  upstream.searchParams.set("scope", ACCESS_SCOPE);
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

/**
 * Exchanges Access's `code` for an ID token. Returns null on any failure.
 *
 * `client_secret_post` rather than Basic: the discovery document offers both,
 * and a form field avoids a base64 header whose encoding of a secret with
 * exotic bytes is one more thing to be subtly wrong.
 */
async function exchangeCode(
  env: WorkerEnv,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const response = await fetch(tokenUrl(env.ACCESS_ISSUER as string), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ACCESS_CLIENT_ID as string,
      client_secret: env.ACCESS_CLIENT_SECRET as string,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { id_token?: unknown };
  return typeof body.id_token === "string" && body.id_token.length > 0 ? body.id_token : null;
}

async function handleCallback(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const headers = new Headers({ "Set-Cookie": clearSessionCookie() });

  if (!code || !stateToken) {
    return withHeaders(
      page("Sign-in failed", "<p>Access did not return an authorization code.</p>", 400),
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

  if (!configured(env)) {
    logConfigError(CONFIG_UNSET);
    return withHeaders(
      page("Not authorized", "<p>This server has no identity provider configured.</p>", 403),
      headers,
    );
  }

  const idToken = await exchangeCode(env, code, new URL("/callback", request.url).href);
  if (!idToken) {
    logEvent({ event: "oauth_callback_rejected", code: "code_exchange" });
    return withHeaders(
      page("Sign-in failed", "<p>Access rejected the authorization code.</p>", 400),
      headers,
    );
  }

  const email = await emailFromIdToken(idToken, env);
  if (!email) {
    // Distinct from a refusal: Access only redirects back when its policy
    // already said yes, so reaching here means the token did not verify or
    // carried no email — a configuration fault, not an access decision.
    logEvent({ event: "oauth_callback_rejected", code: "id_token" });
    return withHeaders(
      page("Sign-in failed", "<p>Could not verify the identity Access returned.</p>", 502),
      headers,
    );
  }

  const props: AuthProps = { login: email };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.request,
    userId: email,
    metadata: { label: email },
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

export const accessHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }

    // `/f/:token` — the standalone carrier. It answers for its own prefix and
    // returns null for anything else, so "everything else 404s" stays true and
    // stays decided here.
    const formPage = await handleFormPage(request, env);
    if (formPage) return formPage;

    // Everything else, `/` included. Nothing about this deployment beyond the
    // OAuth metadata OAuthProvider publishes is discoverable by fetching it.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
