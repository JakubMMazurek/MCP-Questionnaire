/**
 * The Worker's view of its bindings.
 *
 * Two adjustments to the generated `Env`, both forced by how wrangler infers
 * types rather than by anything about the design:
 *
 * 1. `wrangler types` infers a `vars` entry as its string LITERAL, so
 *    `GITHUB_ALLOWED_USERS` would type as `"JakubMMazurek"` and any comparison
 *    against a different login would narrow to `never`. It is widened here.
 * 2. `OAUTH_PROVIDER` is not a configured binding: `OAuthProvider` injects the
 *    helpers object onto `env` before it calls either handler, so it exists at
 *    runtime and nowhere in wrangler.jsonc.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type WorkerEnv = Omit<Env, "ACCESS_CLIENT_ID" | "ACCESS_ISSUER" | "FORM_URL_SECRET"> & {
  /**
   * The Cloudflare Access for SaaS application's client id, and the issuer the
   * authorize/token/jwks endpoints hang off. Both are `vars`, both are public.
   * Optional in the type because absent must be a live possibility the code
   * handles — it fails closed — not a compile error nobody sees.
   */
  ACCESS_CLIENT_ID?: string;
  ACCESS_ISSUER?: string;
  /**
   * HMAC key for `/f/:token` form URLs. A `wrangler secret`, NEVER a `vars`
   * entry — a `vars` entry of the same name REPLACES a secret, which is the
   * trap that has already bitten this deploy once. Optional in the type for
   * the same reason as the allowlist: absent must be a case the code handles
   * (it fails closed), not a compile error nobody sees.
   */
  FORM_URL_SECRET?: string;
  /** Injected per request by OAuthProvider before the handler runs. */
  OAUTH_PROVIDER: OAuthHelpers;
};

/**
 * What the OAuth grant carries into every authenticated MCP request.
 *
 * Exactly one field, deliberately. No upstream token is kept: this server
 * never calls Cloudflare Access on the user's behalf after the callback, so
 * storing one would be a credential at rest bought for nothing. The identity
 * is here because §10's audit-attribution question un-parks the moment an
 * identity exists — it is stamped on writes to the form DO.
 *
 * `login` holds an EMAIL ADDRESS since the move to Access (2026-10-26); it
 * held a GitHub login before. The field keeps its name because what it means
 * has not changed — "who signed in" — and renaming it would churn the DO's
 * stored attributions for no gain.
 */
export type AuthProps = { login: string };

/** Reads `login` out of the opaque props bag. Never throws, never guesses. */
export function loginFromProps(props: Record<string, unknown> | undefined): string | null {
  const login = props?.login;
  return typeof login === "string" && login.length > 0 ? login : null;
}
