/**
 * `/f/:token` — the standalone carrier's two routes, in workerd.
 *
 * Everything here runs against the real Worker: the real token verification,
 * the real ASSETS read, the real Durable Object. The seams are the point — a
 * mocked signature or a stubbed DO would prove nothing about either.
 *
 * What these pin down is the part a person meets when something has gone wrong.
 * A form link is handed to someone who was not in the conversation; it will be
 * opened late, forwarded, truncated by a mail client, or fished out of a
 * screenshot a week later. Each of those has a screen, and each screen has to
 * say what happened and what to do — §6.3's standard, applied outside the
 * validator.
 */

import { SELF } from "cloudflare:test";
import { assumptionLedger } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import { FORM_URL_TTL_MS, mintFormToken } from "../src/form-url.js";
import { UI_EXTENSION_ID } from "../src/ui-capability.js";
import { ALLOWED_LOGIN, connect, firstText, rawCall } from "./harness.js";

/** Matches `.dev.vars` — the tests sign with the same fake the Worker reads. */
const SECRET = "dev-only-not-a-real-signing-key";

const ledger = () => structuredClone(assumptionLedger) as unknown as Record<string, unknown>;

const fetchPath = (path: string, init?: RequestInit) =>
  SELF.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { Host: "localhost", ...((init?.headers as Record<string, string>) ?? {}) },
    }) as never,
  );

async function storedForm(): Promise<string> {
  const { call, close } = await connect();
  const result = await call("gather_decisions", { form: ledger() });
  await close();
  return (result.structuredContent as { formId?: string }).formId ?? "";
}

async function linkFor(formId: string, options: { now?: number; ttlMs?: number } = {}) {
  const token = await mintFormToken(SECRET, { formId, login: ALLOWED_LOGIN, ...options });
  return { token, path: `/f/${token}` };
}

const post = (path: string, body: unknown) =>
  fetchPath(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const answered = (value: string) => ({
  "assumptions[r_eu][verdict]": { state: "answered", value },
});

/* -------------------------------------------------------------------------- */

describe("serving the page", () => {
  it("serves the renderer with this form's schema and answers inlined", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    const response = await fetchPath(path);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // The bundle, not a redirect to it: one document, nothing to fetch.
    expect(html).toContain('id="mcpq-bootstrap"');
    expect(html).toContain(assumptionLedger.title);
    expect(html.length).toBeGreaterThan(100_000);
  });

  it("sends the page's own CSP — one directive looser than the host's, and no more", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    const csp = (await fetchPath(path)).headers.get("content-security-policy") ?? "";

    // §8 Q1: the page may talk to its own origin, because that is where drafts
    // go now. Everything else stays as tight as the host's default.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    // And it stays out of everyone else's iframe — including the widget
    // sandbox whose refusal to frame anything is why this route exists.
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("does not let a form's own text end the bootstrap element", async () => {
    const hostile = ledger();
    (hostile as { title: string }).title = 'Rollout </script><script>alert("xss")</script>';
    const { call, close } = await connect();
    const result = await call("gather_decisions", { form: hostile });
    await close();
    const formId = (result.structuredContent as { formId?: string }).formId ?? "";

    const { path } = await linkFor(formId);
    const html = await (await fetchPath(path)).text();
    // The escaped form is present; the closing tag that would have escaped the
    // element is not. A label is data, and it stays data.
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain('</script><script>alert("xss")');
  });

  it("tells someone whose link has expired what to do about it", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId, { now: Date.now() - FORM_URL_TTL_MS - 1_000 });
    const response = await fetchPath(path);
    const html = await response.text();

    expect(response.status).toBe(410);
    expect(html).toContain("expired");
    // What to do next, not just what went wrong.
    expect(html).toMatch(/ask me/i);
    // Never the formId: the link is what expired, and the id is a capability.
    expect(html).not.toContain(formId);
  });

  it("refuses a token it did not sign", async () => {
    const formId = await storedForm();
    const { token } = await linkFor(formId);
    const forged = `${token.slice(0, -4)}AAAA`;
    const response = await fetchPath(`/f/${forged}`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("not issued by this server");
  });

  it("refuses a valid token for a form the store no longer holds", async () => {
    const { path } = await linkFor("0123456789abcdef0123456789abcdef");
    const response = await fetchPath(path);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no longer stored");
  });
});

describe("taking answers", () => {
  it("writes a draft into the same Durable Object the tools read", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);

    const response = await post(path, { answers: answered("fix") });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });

    // The whole claim of the route: answers reach the agent by the same pull.
    const { call, close } = await connect();
    const answers = await call("get_answers", { formId });
    await close();
    expect(firstText(answers)).toContain("fix");
  });

  it("stamps a submit, so get_answers stops calling them answers so far", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);

    await post(path, { answers: answered("confirm"), complete: true, submitted: true });

    const { call, close } = await connect();
    const answers = await call("get_answers", { formId });
    await close();
    expect(firstText(answers)).toMatch(/submitted/i);
  });

  it("answers a refusal in the same vocabulary save_draft uses", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);

    // Two writes inside the DO's minimum interval: the second is refused for
    // PACE, and the page needs to hear that as "slow down", not as "broken".
    await post(path, { answers: answered("fix") });
    const second = await post(path, { answers: answered("tbd") });

    expect(second.status).toBe(429);
    const verdict = (await second.json()) as { code?: string; retryAfterMs?: number };
    expect(verdict.code).toBe("throttled");
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
  });

  it("rejects an expired token on the write path too", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId, { now: Date.now() - FORM_URL_TTL_MS - 1_000 });
    const response = await post(path, { answers: answered("fix") });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "expired" });
  });

  it("refuses an answer map that is not one, without touching the store", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    const response = await post(path, { answers: "not an answer map" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "malformed_answers" });
  });
});

describe("get_form_link", () => {
  it("mints a link that opens the form", async () => {
    const formId = await storedForm();
    const { call, close } = await connect();
    const result = await call("get_form_link", { formId });
    await close();

    const url = (result.structuredContent as { url?: string }).url ?? "";
    expect(url).toMatch(/^http:\/\/localhost\/f\/1\./);
    // The link the agent hands over is a link that works.
    const page = await fetchPath(new URL(url).pathname);
    expect(page.status).toBe(200);
  });

  it("says the form is unaffected when it cannot mint one", async () => {
    const { call, close } = await connect();
    const result = await call("get_form_link", { formId: "not-a-form-id" });
    await close();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("not found");
  });
});

describe("the surface stays closed", () => {
  it("still 404s the root and the bundle's own path", async () => {
    for (const path of ["/", "/index.html", "/f/", "/f"]) {
      expect((await fetchPath(path)).status, path).toBe(404);
    }
  });

  it("refuses methods the route does not implement", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    const response = await fetchPath(path, { method: "DELETE" });
    expect(response.status).toBe(405);
  });
});

describe("choosing the carrier", () => {
  /**
   * The whole point of the branch: chat and Cowork keep the form, Claude Code
   * gets a link, and neither needs the model to work out which it is in.
   */
  it("hands a link to a locally-run Claude Code", async () => {
    // Everything Claude Code sends, measured on the wire 2026-09-09 — the
    // User-Agent included, because that is the half that decides.
    const result = await rawCall(
      "gather_decisions",
      { form: ledger() },
      {
        clientName: "claude-code",
        capabilities: { roots: {}, elicitation: {} },
        userAgent: "claude-code/2.1.260 (claude-desktop; external, cli)",
      },
    );

    const structured = result.structuredContent as { formId?: string; url?: string };
    expect(structured.url).toMatch(/\/f\/1\./);
    // Both channels, because this client drops content[0].text and delivers
    // structuredContent — a link in the prose alone would reach nobody here.
    expect(firstText(result)).toContain(structured.url ?? "no url");
    expect(firstText(result)).toContain("does not render forms inline");

    // And it opens.
    const page = await fetchPath(new URL(structured.url ?? "").pathname);
    expect(page.status).toBe(200);
  });

  it("leaves a host that declares MCP Apps exactly as it was", async () => {
    const result = await rawCall(
      "gather_decisions",
      { form: ledger() },
      { clientName: "claude-ai", capabilities: { extensions: { [UI_EXTENSION_ID]: {} } } },
    );

    expect(firstText(result)).toContain("Form displayed; awaiting input");
    expect((result.structuredContent as { url?: string }).url).toBeUndefined();
  });

  /**
   * The one that shipped broken. Cowork declares exactly what Claude Code
   * declares — same client name, same capabilities, no extensions map — and
   * renders the form regardless. It reaches the Worker through Anthropic's
   * fetcher rather than from the user's machine, and that is the whole of the
   * difference.
   */
  it("leaves Cowork alone, though it declares exactly what Claude Code declares", async () => {
    const result = await rawCall(
      "gather_decisions",
      { form: ledger() },
      {
        clientName: "claude-code",
        capabilities: { roots: {}, elicitation: {} },
        userAgent: "Claude-User",
      },
    );

    expect(firstText(result)).toContain("Form displayed; awaiting input");
    expect((result.structuredContent as { url?: string }).url).toBeUndefined();
  });

  it("leaves a client that declares nothing exactly as it was", async () => {
    const { call, close } = await connect();
    const result = await call("gather_decisions", { form: ledger() });
    await close();

    // Silence is not evidence. An unknown client behaves as it did before this
    // server could tell the difference, and get_form_link stays one call away.
    expect(firstText(result)).toContain("Form displayed; awaiting input");
    expect((result.structuredContent as { url?: string }).url).toBeUndefined();
  });

  it("reopens with a link too, for the client that cannot show one", async () => {
    const formId = await storedForm();
    const result = await rawCall(
      "load_form",
      { formId },
      {
        clientName: "claude-code",
        capabilities: { roots: {}, elicitation: {} },
        userAgent: "claude-code/2.1.260 (claude-desktop; external, cli)",
      },
    );

    // "Put this form back on screen" means nothing on a client with no screen.
    expect((result.structuredContent as { url?: string }).url).toMatch(/\/f\/1\./);
  });
});

describe("await_answers", () => {
  /**
   * The gap this closes: a page cannot send `ui/message`, so without this the
   * person submits, nothing happens, and they come back to ask for their own
   * answers to be read out. Jakub hit exactly that, 2026-09-09.
   */
  it("returns the answers as soon as a submit lands", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);

    // The wait starts BEFORE the submit, as it does in life.
    const waiting = rawCall("await_answers", { formId, waitMs: 8_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await post(path, { answers: answered("confirm"), complete: true, submitted: true });

    const result = await waiting;
    expect(firstText(result)).toMatch(/Submitted/);
    expect(firstText(result)).toContain("confirm");
  });

  it("says what is saved so far rather than pretending, when nothing arrives", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    await post(path, { answers: answered("fix") });

    const result = await rawCall("await_answers", { formId, waitMs: 0 });
    expect(firstText(result)).toContain("Not submitted yet");
    // It tells the agent to keep waiting, not to go and pester the user.
    expect(firstText(result)).toContain("await_answers again");
    expect(firstText(result)).toMatch(/Do not ask the user/i);
    expect(result.structuredContent).toMatchObject({ submitted: false, answered: 1 });
  });

  it("returns immediately for a form already submitted", async () => {
    const formId = await storedForm();
    const { path } = await linkFor(formId);
    await post(path, { answers: answered("confirm"), complete: true, submitted: true });

    const started = Date.now();
    const result = await rawCall("await_answers", { formId, waitMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(firstText(result)).toMatch(/Submitted/);
  });
});
