/**
 * The GitHub allowlist and the flow that enforces it (§3, build step 7).
 *
 * Two levels, deliberately. The predicate is a pure function and gets pure
 * tests — case, whitespace, empty list, absent list — because that is where the
 * subtle bugs live (GitHub logins are case-insensitive, and an unset var must
 * fail CLOSED). The flow gets end-to-end tests through the real Worker, because
 * "the predicate is right" and "the predicate is actually consulted before a
 * token is minted" are different claims and only the second one matters.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ALLOWLIST_UNSET, isAllowedLogin, parseAllowlist } from "../src/allowlist.js";
import { ALLOWED_LOGIN, authorize, pkce, registerClient, stubGitHub } from "./harness.js";

/* -------------------------------------------------------------------------- */
/* the predicate                                                              */
/* -------------------------------------------------------------------------- */

describe("the allowlist predicate", () => {
  it("admits a listed login", () => {
    expect(isAllowedLogin("JakubMMazurek", "JakubMMazurek")).toBe(true);
  });

  it("is case-insensitive on BOTH sides — GitHub logins are", () => {
    expect(isAllowedLogin("jakubmmazurek", "JakubMMazurek")).toBe(true);
    expect(isAllowedLogin("JAKUBMMAZUREK", "jakubmmazurek")).toBe(true);
    expect(isAllowedLogin("JakubMMazurek", "JAKUBMMAZUREK")).toBe(true);
  });

  it("tolerates whitespace and empty entries in the var", () => {
    expect(isAllowedLogin("octocat", " alice , octocat ,, bob ")).toBe(true);
    expect(parseAllowlist(" alice , octocat ,, bob ")).toEqual(["alice", "octocat", "bob"]);
  });

  it("refuses a login that is not on the list", () => {
    expect(isAllowedLogin("mallory", "alice,bob")).toBe(false);
  });

  it("refuses a login that is only a SUBSTRING of a listed one", () => {
    // Whole-entry equality, not `includes` on the raw string — the difference
    // between an allowlist and an invitation.
    expect(isAllowedLogin("jakub", "JakubMMazurek")).toBe(false);
    expect(isAllowedLogin("azure", "JakubMMazurek")).toBe(false);
  });

  it("fails CLOSED when the list is unset, empty, or only separators", () => {
    for (const raw of [undefined, "", "   ", ",", " , , "]) {
      expect(isAllowedLogin("JakubMMazurek", raw), JSON.stringify(raw)).toBe(false);
    }
  });

  it("refuses a blank login even against a populated list", () => {
    for (const login of [undefined, null, "", "   "]) {
      expect(isAllowedLogin(login, "alice"), JSON.stringify(login)).toBe(false);
    }
  });

  it("has an operator-facing diagnosis that names the fix and no user data", () => {
    expect(ALLOWLIST_UNSET).toContain("GITHUB_ALLOWED_USERS");
    expect(ALLOWLIST_UNSET).toContain("wrangler.jsonc");
  });
});

/* -------------------------------------------------------------------------- */
/* the flow                                                                   */
/* -------------------------------------------------------------------------- */

describe("the GitHub authorization flow", () => {
  it("completes for an allowlisted login and yields a working token", async () => {
    const { callback, accessToken } = await authorize(ALLOWED_LOGIN);
    expect(callback.status).toBe(302);
    expect(accessToken).toBeTruthy();

    const response = await SELF.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Host: "localhost",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }) as never,
    );
    expect(response.status).not.toBe(401);
  });

  it("matches the allowlist case-insensitively end to end", async () => {
    // wrangler.jsonc says `JakubMMazurek`; GitHub is asked to answer in a
    // different case. The grant must still complete.
    const { callback, accessToken } = await authorize("jakubmmazurek");
    expect(callback.status).toBe(302);
    expect(accessToken).toBeTruthy();
  });

  it("403s a login that is not on the list, and mints nothing", async () => {
    const { callback, accessToken } = await authorize("mallory");
    expect(callback.status).toBe(403);
    expect(accessToken).toBeUndefined();

    const body = await callback.text();
    // Names the visitor's OWN login — the likeliest cause is "wrong GitHub
    // account", and they already knew which one they used.
    expect(body).toContain("mallory");
    expect(body).toContain("GITHUB_ALLOWED_USERS");
    // ...and names nobody else. The list is not enumerated to a stranger.
    expect(body).not.toContain(ALLOWED_LOGIN);
    // No credential ever reaches the page.
    expect(body).not.toContain("gho_test_token");
  });

  it("refuses a callback whose state was never issued", async () => {
    stubGitHub(ALLOWED_LOGIN);
    const response = await SELF.fetch(
      new Request("http://localhost/callback?code=gh_code&state=deadbeef", {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a callback replayed WITHOUT the session cookie (CSRF)", async () => {
    stubGitHub(ALLOWED_LOGIN);
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const authorizeUrl = new URL("http://localhost/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost/oauth/callback");
    authorizeUrl.searchParams.set("state", "client-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const bounce = await SELF.fetch(
      new Request(authorizeUrl.href, {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(bounce.status).toBe(302);
    const upstream = new URL(bounce.headers.get("Location") ?? "");
    expect(upstream.origin).toBe("https://github.com");

    // The attacker has the state (GitHub echoes it to whoever follows the
    // link) but not the cookie. That must not be enough.
    const stolen = upstream.searchParams.get("state") ?? "";
    const response = await SELF.fetch(
      new Request(`http://localhost/callback?code=gh_code&state=${stolen}`, {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("never reaches GitHub for a request with no PKCE challenge", async () => {
    const clientId = await registerClient();
    const response = await SELF.fetch(
      new Request(
        `http://localhost/authorize?response_type=code&client_id=${clientId}` +
          "&redirect_uri=http%3A%2F%2Flocalhost%2Foauth%2Fcallback&state=s",
        { headers: { Host: "localhost" }, redirect: "manual" },
      ) as never,
    );
    // OAuth 2.1 makes PKCE mandatory and `parseAuthRequest` enforces it. The
    // rejection goes back to the client (redirect_uri validated by then), NOT
    // onward to GitHub — the user is never asked to consent to a grant that
    // was already invalid.
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("http://localhost");
    expect(location.searchParams.get("error")).toBeTruthy();
  });

  it("rejects an authorize request from an unregistered client", async () => {
    const response = await SELF.fetch(
      new Request(
        "http://localhost/authorize?response_type=code&client_id=nope&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&state=s",
        { headers: { Host: "localhost" }, redirect: "manual" },
      ) as never,
    );
    // No validated redirect_uri, so the library's contract is "render locally,
    // never redirect" — the handler must not bounce an error to an unvalidated
    // URL, and must not reach GitHub either.
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});
