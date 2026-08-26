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

export type WorkerEnv = Omit<Env, "GITHUB_ALLOWED_USERS"> & {
  /**
   * Comma-separated GitHub logins, case-insensitive (see allowlist.ts).
   * Optional in the type because absent must be a live possibility the code
   * handles — it fails closed — not a compile error nobody sees.
   */
  GITHUB_ALLOWED_USERS?: string;
  /** Injected per request by OAuthProvider before the handler runs. */
  OAUTH_PROVIDER: OAuthHelpers;
};

/**
 * What the OAuth grant carries into every authenticated MCP request.
 *
 * Exactly one field, deliberately. The GitHub access token is NOT kept: this
 * server never calls GitHub on the user's behalf after the callback, so
 * storing the token would be a credential at rest bought for nothing. The
 * login is here because §10's audit-attribution question un-parks the moment
 * an identity exists (build step 7) — it is stamped on writes to the form DO.
 */
export type AuthProps = { login: string };

/** Reads `login` out of the opaque props bag. Never throws, never guesses. */
export function loginFromProps(props: Record<string, unknown> | undefined): string | null {
  const login = props?.login;
  return typeof login === "string" && login.length > 0 ? login : null;
}
