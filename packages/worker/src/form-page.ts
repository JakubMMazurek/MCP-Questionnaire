/**
 * `/f/:token` — the form as a page (PROPOSAL-standalone-route.md §4).
 *
 * The third carrier. Chat, Cowork, Desktop chat and mobile mount the renderer
 * as `ui://forms/renderer`; Claude Code mounts nothing at all, so for that
 * carrier the same bundle is served here as an ordinary web page and the
 * person opens it — in the desktop Browser pane, through URL-mode elicitation,
 * or from a plain link.
 *
 *   GET  /f/:token   the bundle, with this form's schema and answers inlined
 *   POST /f/:token   a draft or a submit, into the same Durable Object
 *
 * Two things this route does NOT do, both deliberate:
 *
 *  - It does not read the ASSETS binding as a public directory. `GET /` is
 *    still a 404 and `run_worker_first: true` still holds; the bundle is read
 *    by Worker code, exactly as `resources/read` reads it.
 *  - It does not invent a second write path. The POST parses what the page
 *    sends and hands it to `FormStore.saveDraft` — the same method, the same
 *    caps, the same verdicts as the `save_draft` tool — and returns that
 *    verdict as the body, so one vocabulary describes a refusal on either
 *    carrier.
 */

import type { Answers } from "@mcpq/schema";
import { validateAnswers } from "@mcpq/schema";
import type { WorkerEnv } from "./env.js";
import type { FormState, SaveDraftResult } from "./form-do.js";
import { formStore } from "./form-store.js";
import { verifyFormToken } from "./form-url.js";
import { logConfigError, logEvent } from "./log.js";
import { readRendererBundle } from "./renderer-resource.js";

export const FORM_PAGE_PREFIX = "/f/";

/**
 * The page's own policy (§8 Q1, `decided 2026-09-09`).
 *
 * §8's `connect-src 'none'` is the HOST's default under MCP Apps, applied
 * because §7.1 omits `ui.csp`. There is no host here, so the policy is ours to
 * send — and it loosens exactly one directive, because §3 routed drafts through
 * the host only for want of a POST. Everything else stays as tight as the
 * host's: no CDN, no external fonts, no telemetry, and the bundle is checked
 * for external references at build time either way.
 *
 * `frame-ancestors 'none'` keeps this page out of everyone else's iframe —
 * including the widget sandbox whose refusal to frame anything started this
 * whole route.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function htmlHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // A form URL is a capability with a clock on it. Nothing about it should
    // sit in a shared cache, and the page itself is per-form.
    "cache-control": "no-store, private",
  });
}

function jsonHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
}

/**
 * A page that says what happened and what to do about it (§6.3's standard,
 * applied to the one screen a person sees when a link has gone stale).
 *
 * Self-contained markup: the same CSP governs it, so no stylesheet and no
 * script. It never names the formId — the link is the thing that expired, and
 * repeating an internal capability on an error screen only spreads it.
 */
function notice(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem}main{max-width:32rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 .75rem;opacity:.85}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: htmlHeaders() });
}

const EXPIRED = notice.bind(
  null,
  "This form link has expired",
  [
    "<p>Form links are good for 12 hours. This one is older than that, so it no longer opens.</p>",
    "<p>Ask me for the form again in your session and I will send a fresh link. Anything you had already saved is still there.</p>",
  ].join(""),
);

const UNKNOWN = notice.bind(
  null,
  "This link does not open a form",
  [
    "<p>The link is malformed or was not issued by this server.</p>",
    "<p>If you copied it by hand, check nothing was cut off. Otherwise ask me for a new one in your session.</p>",
  ].join(""),
);

const GONE = notice.bind(
  null,
  "This form is no longer stored",
  [
    "<p>Forms expire 30 days after they were last opened or answered, and this one is past that.</p>",
    "<p>Ask me in your session and I will render a fresh one, prefilled with what I already know.</p>",
  ].join(""),
);

/**
 * Inlines the bootstrap into the bundle's placeholder element.
 *
 * `<` is escaped throughout, which is what stops a `</script>` inside a label,
 * a description or someone's typed answer from ending the element early. The
 * element is `type="application/json"`, so the payload is never executed even
 * if something did slip through — two independent reasons the page is safe,
 * because one of them is a regex.
 */
function inlineBootstrap(html: string, bootstrap: unknown): string {
  const json = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return html.replace(
    /(<script type="application\/json" id="mcpq-bootstrap">)[\s\S]*?(<\/script>)/,
    (_match, open: string, close: string) => `${open}${json}${close}`,
  );
}

type Body = {
  answers?: unknown;
  complete?: unknown;
  submitted?: unknown;
};

/** The save_draft verdict, as an HTTP status. The body is the verdict itself. */
function statusFor(result: SaveDraftResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "throttled":
      return 429;
    case "too_large":
      return 413;
    case "no_form":
      return 404;
    default:
      return 400;
  }
}

async function handleGet(env: WorkerEnv, state: FormState, token: string): Promise<Response> {
  let html: string;
  try {
    html = await readRendererBundle(env);
  } catch (error) {
    logConfigError("form_page_bundle_missing");
    throw error;
  }
  const bootstrap = {
    form: state.form,
    formId: state.form.formId ?? null,
    answers: state.answers,
    endpoint: `${FORM_PAGE_PREFIX}${token}`,
    ...(state.submittedAt === null ? {} : { submitted: true }),
  };
  // §3's closed log vocabulary: which path, never whose form.
  logEvent({ event: "form_page_served", code: state.submittedAt === null ? "draft" : "submitted" });
  return new Response(inlineBootstrap(html, bootstrap), { status: 200, headers: htmlHeaders() });
}

async function handlePost(
  env: WorkerEnv,
  formId: string,
  login: string,
  request: Request,
): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ ok: false, code: "malformed_answers" }), {
      status: 400,
      headers: jsonHeaders(),
    });
  }

  // The same light shape check the tool does (§6.3): the answer map is the
  // user's data, not an authored artefact. Malformed VALUES are the renderer's
  // gate, not this route's.
  const shape = validateAnswers(body.answers);
  if (!shape.ok || !shape.answers) {
    return new Response(JSON.stringify({ ok: false, code: "malformed_answers" }), {
      status: 400,
      headers: jsonHeaders(),
    });
  }

  const result: SaveDraftResult = await formStore(env, formId).saveDraft({
    answers: shape.answers as Answers,
    // §10 audit attribution. The page has no identity of its own, so the
    // writer recorded is the login the LINK was minted for — which is a claim
    // about who was given the form, not about who filled it in. That is the
    // honest reading of a URL anyone holding it can open, and it is the same
    // claim the token itself makes.
    updatedBy: login,
    ...(body.complete === true ? { complete: true } : {}),
    ...(body.submitted === true ? { submitted: true } : {}),
  });

  const verdict = result.ok
    ? { ok: true, saved: result.saved, deleted: result.deleted }
    : {
        ok: false,
        code: result.code,
        ...(result.code === "throttled" ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.code === "too_large" ? { bytes: result.bytes, limit: result.limit } : {}),
      };
  return new Response(JSON.stringify(verdict), {
    status: statusFor(result),
    headers: jsonHeaders(),
  });
}

/**
 * Routes `/f/:token`, or returns null when the request is not for this route.
 *
 * Null rather than a 404 so the caller keeps owning what "everything else"
 * means — this module answers for its own prefix and nothing more.
 */
export async function handleFormPage(request: Request, env: WorkerEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(FORM_PAGE_PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }

  const secret = env.FORM_URL_SECRET;
  if (!secret) {
    // Fails closed, and says so once in the log rather than to the visitor: an
    // unconfigured signing key is an operator problem, and describing it to
    // whoever found the URL only tells an attacker which lever is loose.
    logConfigError("form_url_secret_unset");
    return UNKNOWN(404);
  }

  const token = url.pathname.slice(FORM_PAGE_PREFIX.length);
  const verified = await verifyFormToken(secret, token);
  if (!verified.ok) {
    logEvent({ event: "form_page_rejected", code: verified.reason });
    if (verified.reason === "expired") {
      return request.method === "POST"
        ? new Response(JSON.stringify({ ok: false, code: "expired" }), {
            status: 401,
            headers: jsonHeaders(),
          })
        : EXPIRED(410);
    }
    return request.method === "POST"
      ? new Response(JSON.stringify({ ok: false, code: "bad_token" }), {
          status: 401,
          headers: jsonHeaders(),
        })
      : UNKNOWN(404);
  }

  const { formId } = verified.token;

  if (request.method === "POST") {
    return handlePost(env, formId, verified.token.login, request);
  }

  const state = await formStore(env, formId).getState();
  // A valid token for a form the store no longer holds: the token outlived the
  // DO's 30-day idle expiry, or the id was never stored. Same screen either
  // way — there is nothing to render and nothing the person can do here.
  if (!state) return GONE(404);
  return handleGet(env, state, token);
}
