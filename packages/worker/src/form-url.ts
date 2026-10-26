/**
 * Signed form URLs (PROPOSAL-standalone-route.md §4, `decided 2026-09-09`).
 *
 * The standalone carrier hands a person a link. A link cannot carry a bearer
 * token the way `/mcp` does, and the formId must not become the credential —
 * §3 makes the id a capability held between the agent and the Worker, and a URL
 * gets pasted into tickets, chat and browser history. So the URL carries a
 * token that PROVES the Worker minted it: formId, an expiry, and the login it
 * was minted for, under an HMAC the Worker alone can compute.
 *
 * What the token is not:
 *
 *  - **Not a session.** It authorises exactly one form and nothing else. There
 *    is no cookie, and the POST route sends `credentials: "omit"`.
 *  - **Not bound to the viewer.** The login is signed IN for provenance and
 *    revocation, and is deliberately not checked against whoever opens the
 *    page: the page has no login, and forwarding a form to the person who
 *    should actually answer it is a legitimate thing to do. The TTL is what
 *    bounds that.
 *
 * It is weaker than the bearer token on `/mcp`. That is stated plainly in the
 * proposal, and the 12-hour life is the mitigation: long enough to survive
 * lunch, a closed laptop or a hand-off, short enough that a link found in a
 * screenshot a week later opens nothing.
 */

import { isFormId } from "./form-id.js";

/** 12 hours (§8 Q2). */
export const FORM_URL_TTL_MS = 12 * 60 * 60 * 1_000;

/**
 * Version prefix, so a future signing change is a rejection and not a mystery.
 *
 * Bumped to "2" on 2026-10-26: the login became an email address when auth
 * moved to Cloudflare Access, and the payload now carries it base64url-encoded
 * rather than dot-mangled (see `payloadOf`). Links minted under "1" are
 * rejected as malformed, which is the point of having the prefix.
 */
const VERSION = "2";

export type FormToken = {
  formId: string;
  /** Epoch millis. */
  expiresAt: number;
  /** The email the link was minted for. Provenance only. */
  login: string;
};

export type TokenFailure = "malformed" | "expired" | "bad_signature";

export type VerifyResult = { ok: true; token: FormToken } | { ok: false; reason: TokenFailure };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The login is base64url-encoded, not interpolated raw.
 *
 * The payload is dot-separated and an email address contains dots, so a raw
 * login would split the token and change how many parts `verifyFormToken`
 * sees. The previous code replaced dots with underscores, which was safe while
 * logins were GitHub usernames (they cannot contain a dot) but is lossy for an
 * email: `a@b.co.uk` and `a@b_co_uk` would sign identically and only one of
 * them is a real address. Encoding keeps the five parts AND the exact bytes.
 */
const encodeLogin = (login: string): string => base64url(new TextEncoder().encode(login));

function decodeLogin(value: string): string | null {
  const bytes = fromBase64url(value);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** `v2.<formId>.<expiresAt>.<b64url(login)>` — the bytes the signature covers. */
function payloadOf(token: FormToken): string {
  return [VERSION, token.formId, String(token.expiresAt), encodeLogin(token.login)].join(".");
}

export async function mintFormToken(
  secret: string,
  input: { formId: string; login: string; now?: number; ttlMs?: number },
): Promise<string> {
  const token: FormToken = {
    formId: input.formId,
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? FORM_URL_TTL_MS),
    login: input.login,
  };
  const payload = payloadOf(token);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await keyFor(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Verifies a token, in the order that leaks least.
 *
 * The signature is checked BEFORE the expiry, so an attacker cannot use the
 * difference between "expired" and "bad signature" to learn whether a forged
 * token was otherwise well-formed. `crypto.subtle.verify` is constant-time.
 */
export async function verifyFormToken(
  secret: string,
  value: string,
  options: { now?: number } = {},
): Promise<VerifyResult> {
  const parts = value.split(".");
  if (parts.length !== 5) return { ok: false, reason: "malformed" };
  const [version, formId, expiresAt, encodedLogin, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION || !isFormId(formId) || !/^\d+$/.test(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  const bytes = fromBase64url(signature);
  if (!bytes) return { ok: false, reason: "malformed" };
  const login = decodeLogin(encodedLogin);
  if (login === null) return { ok: false, reason: "malformed" };

  const token: FormToken = { formId, expiresAt: Number(expiresAt), login };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await keyFor(secret),
    bytes as unknown as ArrayBuffer,
    new TextEncoder().encode(payloadOf(token)),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (token.expiresAt <= (options.now ?? Date.now())) return { ok: false, reason: "expired" };
  return { ok: true, token };
}

/** The absolute URL a person opens. `origin` comes from the request. */
export function formUrl(origin: string, token: string): string {
  return `${origin}/f/${token}`;
}
