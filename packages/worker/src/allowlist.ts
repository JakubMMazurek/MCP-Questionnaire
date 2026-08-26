/**
 * The GitHub username allowlist (§3, build step 7).
 *
 * This is the whole access-control story now that the unguessable base path is
 * gone. It is deliberately the dumbest possible mechanism: a comma-separated
 * list of GitHub logins in `vars`, matched case-insensitively, checked once at
 * the end of the OAuth callback before any token is minted.
 *
 * Why `vars` and not a secret: the list is not a credential — knowing that
 * `jakubmmazurek` may use this server buys an attacker nothing, because the
 * gate is "prove you ARE that GitHub account", which only GitHub can grant.
 * Keeping it in `vars` means adding a teammate is a one-line config change and
 * a redeploy, visible in the diff, instead of an invisible `wrangler secret
 * put` nobody can review. (It also avoids the step-4 trap in reverse: a `vars`
 * entry REPLACES a same-named secret, so a value that lives in `vars` must
 * never also be a secret.)
 *
 * Fail CLOSED, same posture the base path had: an unset or empty list admits
 * nobody. A deploy that forgets the allowlist locks everyone out rather than
 * letting everyone in.
 *
 * GitHub logins are case-insensitive and unique case-insensitively, so
 * lowercasing both sides is the correct comparison, not a convenience.
 */

/** Splits the raw `vars` value into normalised logins. Never throws. */
export function parseAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Is this GitHub login allowed in?
 *
 * An empty list is a closed door (see above), and a blank login is never
 * allowed — GitHub always returns one, so a blank here means the user lookup
 * went wrong and the safe reading is "no".
 */
export function isAllowedLogin(login: string | undefined | null, raw: string | undefined): boolean {
  const normalised = login?.trim().toLowerCase();
  if (!normalised) return false;
  const allowed = parseAllowlist(raw);
  if (allowed.length === 0) return false;
  return allowed.includes(normalised);
}

/** What an operator needs in the logs when the list is missing. Carries no user data. */
export const ALLOWLIST_UNSET =
  "GITHUB_ALLOWED_USERS is unset or empty — every GitHub login is refused. Set it in wrangler.jsonc `vars` to a comma-separated list of GitHub logins and redeploy.";
