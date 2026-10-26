/**
 * The Cloudflare Access authorization flow (replaced the GitHub flow
 * 2026-10-26).
 *
 * There is no allowlist predicate to unit-test any more, and that absence is
 * the headline change: membership moved into the Zero Trust "Tech Team"
 * policy, which refuses an unlisted user at Access's own login page and never
 * redirects back here. The Worker therefore has no refusal path of its own to
 * exercise — what it has instead is a token to verify, so that is what these
 * tests push on.
 *
 * Everything runs through the real Worker. "The ID token is verified" and "the
 * verification is actually consulted before a token is minted" are different
 * claims and only the second one matters.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ALLOWED_LOGIN, authorize, pkce, registerClient, stubAccess } from "./harness.js";

const ACCESS_ORIGIN = "https://365-finance.cloudflareaccess.com";

/* -------------------------------------------------------------------------- */
/* the bounce                                                                 */
/* -------------------------------------------------------------------------- */

describe("the Access authorization flow", () => {
  it("completes for a valid identity and yields a working token", async () => {
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

  it("bounces to the configured Access application, asking only for openid and email", async () => {
    stubAccess(ALLOWED_LOGIN);
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
    expect(upstream.origin).toBe(ACCESS_ORIGIN);
    expect(upstream.pathname.endsWith("/authorization")).toBe(true);
    // `profile` and `groups` are offered by the application and deliberately
    // not requested — a scope you do not ask for is a claim you cannot start
    // depending on by accident.
    expect(upstream.searchParams.get("scope")).toBe("openid email");
    expect(upstream.searchParams.get("response_type")).toBe("code");
  });

  it("admits an address no list in this repo mentions — the policy is the gate", async () => {
    // Under the old allowlist this exact assertion was the refusal test. It
    // inverts on purpose: reaching the callback at all means Access already
    // said yes, so the Worker's job is to believe a verified token, not to
    // second-guess the policy with a copy of the membership list.
    const { callback, accessToken } = await authorize("someone.else@365finance.co.uk");
    expect(callback.status).toBe(302);
    expect(accessToken).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* the ID token                                                               */
/* -------------------------------------------------------------------------- */

describe("ID token verification", () => {
  it("refuses a token minted for a DIFFERENT Access application", async () => {
    // Correctly signed by the same Access tenant, wrong `aud`. This is the
    // claim that stops a token issued for the docs app being replayed here.
    const { callback, accessToken } = await authorize(ALLOWED_LOGIN, {
      audience: "some-other-access-application",
    });
    expect(callback.status).toBe(502);
    expect(accessToken).toBeUndefined();

    const body = await callback.text();
    // Says nothing about which check failed, and leaks no identity.
    expect(body).not.toContain(ALLOWED_LOGIN);
  });

  it("refuses a token from a different issuer", async () => {
    const { callback, accessToken } = await authorize(ALLOWED_LOGIN, {
      issuer: "https://evil.example.com/oidc",
    });
    expect(callback.status).toBe(502);
    expect(accessToken).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* CSRF and request validation                                                */
/* -------------------------------------------------------------------------- */

describe("the callback's defences", () => {
  it("refuses a callback whose state was never issued", async () => {
    stubAccess(ALLOWED_LOGIN);
    const response = await SELF.fetch(
      new Request("http://localhost/callback?code=cf_code&state=deadbeef", {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a callback replayed WITHOUT the session cookie (CSRF)", async () => {
    stubAccess(ALLOWED_LOGIN);
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
    expect(upstream.origin).toBe(ACCESS_ORIGIN);

    // The attacker has the state (Access echoes it to whoever follows the
    // link) but not the cookie. That must not be enough.
    const stolen = upstream.searchParams.get("state") ?? "";
    const response = await SELF.fetch(
      new Request(`http://localhost/callback?code=cf_code&state=${stolen}`, {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("spends the state once — a replayed callback with the cookie still fails", async () => {
    const { callback } = await authorize(ALLOWED_LOGIN);
    expect(callback.status).toBe(302);
    // The harness already walked /authorize → /callback once. The state it
    // used was deleted on first use, so the same URL cannot be spent again.
    const response = await SELF.fetch(
      new Request("http://localhost/callback?code=cf_code&state=deadbeef", {
        headers: { Host: "localhost" },
        redirect: "manual",
      }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("never reaches Access for a request with no PKCE challenge", async () => {
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
    // onward to Access — the user is never asked to sign in to a grant that
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
    // URL, and must not reach Access either.
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});
