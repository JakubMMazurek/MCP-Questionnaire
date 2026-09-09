/**
 * The MCP server: four model-visible tools (gather_decisions, get_form_guide,
 * load_form, get_answers), two app-visible ones (save_draft, get_form_state),
 * and one UI resource (§7.1).
 *
 * One server instance PER REQUEST. `createMcpHandler` (agents/mcp/server, the
 * current recommendation — `McpAgent` is deprecated and feature-frozen) is
 * stateless: no session state lives here, and cross-request data lives "behind
 * an authenticated handle in a Durable Object", which is exactly the per-form DO
 * (§3). The accepted caveat: server-pushed elicitation and sampling do not work
 * on this path. Nothing this app does needs them — every call is a
 * client-initiated `tools/call` or `resources/read`.
 *
 * The rule that shapes every handler below: the schema arrives as tool INPUT and
 * the tool RESULT is a stub (§3). Result text lands in model context, so echoing
 * the schema back would pay for it twice and undo the whole point.
 */

import type { Answers, Form } from "@mcpq/schema";
import { reportAnswers, validateAnswers, validateForm } from "@mcpq/schema";
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { loginFromProps, type WorkerEnv } from "./env.js";
import type { FormState, SaveDraftResult } from "./form-do.js";
import { isFormId, mintFormId } from "./form-id.js";
import { formStore } from "./form-store.js";
import { formUrl, mintFormToken } from "./form-url.js";
import {
  AWAIT_ANSWERS_DESCRIPTION,
  GATHER_DECISIONS_DESCRIPTION,
  GET_ANSWERS_DESCRIPTION,
  GET_FORM_GUIDE_DESCRIPTION,
  GET_FORM_LINK_DESCRIPTION,
  GET_FORM_STATE_DESCRIPTION,
  LOAD_FORM_DESCRIPTION,
  SAVE_DRAFT_DESCRIPTION,
} from "./guidance.js";
import { logConfigError, logEvent } from "./log.js";
import { ARCHETYPES, type ArchetypeName, examplesFor, recipeFor } from "./recipes.js";
import {
  RENDERER_DESCRIPTION,
  RENDERER_MIME_TYPE,
  RENDERER_NAME,
  RENDERER_UI_META,
  RENDERER_URI,
  readRendererBundle,
} from "./renderer-resource.js";
import { clientFingerprint, needsLink } from "./ui-capability.js";
import { diagnosticsWithExample, serialiseExample } from "./worked-example.js";

export const SERVER_INFO = { name: "mcp-questionnaire", version: "0.3.0" } as const;

/* -------------------------------------------------------------------------- */
/* _meta.ui (§7.1)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The NESTED `_meta.ui.resourceUri` form. The flat `_meta["ui/resourceUri"]`
 * key is deprecated in the 2026-01-26 extension — verified against the spec
 * source, not remembered.
 */
const uiMeta = (visibility: ("model" | "app")[]) => ({
  ui: { resourceUri: RENDERER_URI, visibility },
});

/**
 * Tools the UI needs and the model must not see (§7.1). App scope is per-server;
 * hosts MUST reject app calls to tools lacking "app", and cross-server calls
 * from apps are blocked — so this is the whole access-control story for autosave.
 * These carry no `resourceUri`: they render nothing.
 */
const appOnlyMeta = { ui: { visibility: ["app"] } } as const;

/**
 * A text tool: model-visible, renders NOTHING. Attaching `resourceUri` to a
 * tool makes the host mount the renderer and feed it that tool's input — which
 * for `get_form_guide` meant the app receiving `{archetype}` where a form
 * belongs, and the user seeing the "form could not be rendered" state. Only
 * `gather_decisions` and `load_form` produce a view.
 */
const textOnlyMeta = { ui: { visibility: ["model"] } } as const;

/* -------------------------------------------------------------------------- */
/* results                                                                    */
/* -------------------------------------------------------------------------- */

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (body: string): ToolResult => ({ content: [{ type: "text", text: body }] });

const failure = (body: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(structured ? { structuredContent: structured } : {}),
  isError: true,
});

/**
 * §3 — the tool result is a short stub, and the formId is in it because that is
 * also how the agent learns the id (to reopen, and to chain forms).
 *
 * `structuredContent` carries the id as data as well as prose. Per the
 * extension, structuredContent is for rendering and is NOT added to model
 * context, so this is the clean channel for the app to learn which form store
 * it is autosaving into — the host delivers only tool INPUT to the app, and the
 * input never contains a server-minted id.
 */
const stub = (formId: string): ToolResult => ({
  content: [{ type: "text", text: `Form displayed; awaiting input. formId: ${formId}` }],
  structuredContent: { formId },
});

/**
 * The same stub, for a client that told us it cannot mount the renderer.
 *
 * The link goes in BOTH channels deliberately. Claude Code delivers
 * `structuredContent` to the model and DROPS `content[0].text` — measured, not
 * supposed: a `gather_decisions` call from a Code session returns a bare
 * `{"formId":…}` and the stub sentence never arrives. A link that travels only
 * in the prose would therefore reach exactly nobody in the one client this
 * exists for.
 */
const linkStub = (formId: string, url: string): ToolResult => ({
  content: [
    {
      type: "text",
      text: `This client does not render forms inline, so the form is a page instead. Give the user this link — it works for 12 hours:\n\n${url}\n\nWhen they submit, read their answers with get_answers("${formId}"). Hand over the URL by itself; do not repeat the formId beside it.`,
    },
  ],
  structuredContent: { formId, url },
});

/* -------------------------------------------------------------------------- */
/* the Durable Object handle                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The stub for this client: inline where the renderer will mount, a link where
 * it will not (PROPOSAL-standalone-route.md §5).
 *
 * The DEFAULT when a client says nothing is the inline stub — exactly what this
 * server did before it could tell the difference. A client that declares
 * nothing is far more likely to be an unknown host than a broken one, and the
 * failure modes are not symmetric: a link where a form would have rendered puts
 * a capability URL into a conversation that did not need one, while an inline
 * stub where nothing renders is the status quo, with get_form_link one call
 * away.
 */
async function stubFor(
  env: WorkerEnv,
  formId: string,
  origin: string | null,
  login: string | null,
  sources: {
    envelope?: unknown;
    handshake?: unknown;
    clientInfo?: unknown;
    userAgent?: string | null;
  },
): Promise<ToolResult> {
  // One line per carrier decision, wherever the decision is made. It lived in
  // gather_decisions only, which meant a `load_form` — a reopen, the exact
  // thing a person does when a form did not survive a refresh — decided the
  // carrier and logged nothing about the client that got it.
  logEvent({ event: "client", code: clientFingerprint(sources) });
  const link = needsLink(sources);
  if (!link || !origin || !env.FORM_URL_SECRET) {
    logEvent({ event: "stub_served", code: link ? "link_unavailable" : "inline" });
    return stub(formId);
  }
  const token = await mintFormToken(env.FORM_URL_SECRET, { formId, login: login ?? "unknown" });
  logEvent({ event: "stub_served", code: "link" });
  return linkStub(formId, formUrl(origin, token));
}

/** One rendering of "here are the answers", shared by get_answers and await_answers. */
function answersReport(formId: string, state: FormState): ToolResult {
  const report = reportAnswers(state.form, state.answers);
  const when = new Date(state.submittedAt ?? state.updatedAt).toISOString();
  const status =
    state.submittedAt === null
      ? `NOT YET SUBMITTED — this is the draft as it stands at ${when}. The user may still be filling it in.`
      : `Submitted ${when}.`;
  logEvent({ event: "answers_served", count: report.answered });
  return {
    content: [
      {
        type: "text",
        text: [`"${state.form.title}" (formId ${formId})`, status, "", report.text].join("\n"),
      },
    ],
  };
}

/**
 * How long one `await_answers` hop waits, and how often it looks.
 *
 * 45s sits under Claude Code's 60-second first-byte timer with room to spare,
 * and well under the five-minute idle abort. The poll is a Durable Object read
 * on the same instance the writes go to, so it is cheap and strongly
 * consistent — a submit is visible on the next look, not eventually.
 */
const DEFAULT_WAIT_MS = 45_000;
const MAX_WAIT_MS = 55_000;
const POLL_INTERVAL_MS = 1_000;

const NOT_FOUND = (formId: string) =>
  `form ${formId} not found — it may have expired (30-day idle TTL, reset on every read or write). Forms are not recoverable once expired: render a fresh one with gather_decisions, prefilled from what you already know.`;

/**
 * Who is calling (§10 audit attribution, un-parked by build step 7).
 *
 * `getMcpAuthContext()` reads the AsyncLocalStorage the agents handler runs
 * every request inside; its `props` are the ones OAuthProvider decrypted from
 * the grant onto `ctx.props`. Read PER CALL rather than once per server: the
 * server factory and the tool handler are both inside the same store, but only
 * the handler is guaranteed to be, and a stale identity is worse than none.
 *
 * `null` is a legitimate answer, not an error — it is what a directly-driven
 * handler (the DO tests) sees, and attribution marks, it never gates. Nothing
 * downstream branches on the value; it is written to a column and that is all.
 */
function currentLogin(): string | null {
  return loginFromProps(getMcpAuthContext()?.props);
}

/* -------------------------------------------------------------------------- */
/* the server                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param origin The absolute origin this request arrived on, when it is known.
 *   Only `get_form_link` needs it, and it must come from the request rather
 *   than from configuration: this Worker legitimately answers on `workers.dev`,
 *   on localhost under `wrangler dev`, and inside workerd under test, and
 *   pinning one absolute URL would break two of those three. Null under
 *   `serveStdio`, where there is no HTTP request to read it from.
 */
export function createServer(
  env: WorkerEnv,
  origin: string | null = null,
  userAgent: string | null = null,
): McpServer {
  const server = new McpServer(SERVER_INFO);

  /* ------------------------------ the resource --------------------------- */

  /**
   * `_meta.ui` is set BOTH on the declaration (what `resources/list` shows) and
   * on the content item returned by `resources/read`. The spec serves the ui
   * block with the contents, and the content item's copy is the one that
   * governs — so the two are kept identical rather than relying on either.
   *
   * NOT DONE, and it is a real gap against §3's "send
   * notifications/resources/list_changed on change so the host re-fetches":
   * this handler is stateless, so there is no connection to push down. The SDK
   * does advertise `capabilities.resources.listChanged` and the handler exposes
   * `notify.resourcesChanged()`, but that publishes only to clients holding an
   * open `subscriptions/listen` stream, which a per-request server never has.
   * Firing it would also need a trigger, and the only trigger available here is
   * an unauthenticated HTTP endpoint on a server that has no auth by design —
   * a worse trade than the thing it buys. Consequence: after a renderer deploy,
   * a host that cached the bundle keeps the old one until it re-reads. The
   * bundle is versioned by deploy, not by URI (§7.1 wants one stable
   * `ui://forms/renderer` forever), so bumping the URI is not an option
   * either. Revisit if the extension gains a pull-based invalidation.
   */
  server.registerResource(
    RENDERER_NAME,
    RENDERER_URI,
    {
      title: RENDERER_NAME,
      description: RENDERER_DESCRIPTION,
      mimeType: RENDERER_MIME_TYPE,
      _meta: { ui: RENDERER_UI_META },
    },
    async (uri) => {
      const body = await readRendererBundle(env);
      logEvent({ event: "renderer_read", bytes: body.length });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: RENDERER_MIME_TYPE,
            text: body,
            _meta: { ui: RENDERER_UI_META },
          },
        ],
      };
    },
  );

  /* ---------------------------- gather_decisions ------------------------- */

  server.registerTool(
    "gather_decisions",
    {
      title: "MCP Questionnaire",
      description: GATHER_DECISIONS_DESCRIPTION,
      /**
       * LOOSE on purpose (§6.3): "design the inputSchema loose and validate
       * strict in the app: deeply nested recursive JSON Schema degrades model
       * output quality". So the wire contract is "an object under `form`", and
       * the meta-schema is enforced by `validateForm` a line later, where a
       * failure can come back as prose that teaches instead of as a
       * JSON-Schema rejection that does not.
       */
      inputSchema: z.object({
        form: z
          .record(z.string(), z.unknown())
          .describe(
            "The form envelope: { version, title, description?, display?, submitLabel?, sections: [...], rules?: [...], prefill?: {...} }. Call get_form_guide(archetype) for the shape and a worked example. Do not include formId — the server mints it.",
          ),
      }),
      _meta: uiMeta(["model", "app"]),
    },
    async ({ form }, ctx) => {
      const validation = validateForm(form);
      if (!validation.ok || !validation.form) {
        logEvent({
          event: "form_rejected",
          count: validation.errors.length,
        });
        // §6.3 — errors AND the matching worked example. The example is what
        // makes this converge with no skill and no guide call in context.
        return failure(diagnosticsWithExample(validation.text, form));
      }

      const formId = mintFormId();
      const stored: Form = { ...validation.form, formId };
      await formStore(env, formId).init(stored, currentLogin());

      /**
       * Warnings mark, they never gate — the form renders as authored. But the
       * formatted warning text quotes the author's own ids and labels, and this
       * result lands in model context, where §3 allows a stub and nothing else.
       *
       * So what rides along is the closed part: the COUNT and the diagnostic
       * CODES. Codes are a fixed vocabulary, so nothing schema-shaped leaks,
       * and the agent still learns that it shipped a form with no prefill —
       * which is the warning worth learning. The full text is available on the
       * next call, where it will gate nothing either.
       */
      const codes = [...new Set(validation.warnings.map((w) => w.code))];
      const warnings =
        codes.length > 0
          ? ` ${validation.warnings.length} warning(s): ${codes.join(", ")} — the form renders as-is; see get_form_guide for the recipe.`
          : "";
      const result = await stubFor(env, formId, origin, currentLogin(), {
        envelope: (ctx as { mcpReq?: { envelope?: unknown } })?.mcpReq?.envelope,
        handshake: server.server.getClientCapabilities(),
        clientInfo: server.server.getClientVersion(),
        userAgent,
      });
      return {
        ...result,
        content: [{ type: "text", text: `${result.content[0]?.text ?? ""}${warnings}` }],
      };
    },
  );

  /* ----------------------------- get_form_guide -------------------------- */

  server.registerTool(
    "get_form_guide",
    {
      title: "Get form guide",
      description: GET_FORM_GUIDE_DESCRIPTION,
      inputSchema: z.object({
        archetype: z
          .enum(ARCHETYPES)
          .describe("Which recipe to return. Pick by the moment, not the field types."),
      }),
      _meta: textOnlyMeta,
    },
    async ({ archetype }) => {
      const name = archetype as ArchetypeName;
      const examples = examplesFor(name);
      const body = [
        recipeFor(name),
        "",
        `WORKED EXAMPLE${examples.length > 1 ? "S" : ""} — valid as written against the meta-schema. Pass one of these as \`form\` to gather_decisions with your own content substituted.`,
        ...examples.map(serialiseExample),
      ].join("\n\n");
      logEvent({ event: "guide_served", code: name, count: examples.length });
      return text(body);
    },
  );

  /* -------------------------------- load_form ---------------------------- */

  server.registerTool(
    "load_form",
    {
      title: "Load form",
      description: LOAD_FORM_DESCRIPTION,
      inputSchema: z.object({
        formId: z.string().describe("The id returned by gather_decisions."),
      }),
      _meta: uiMeta(["model", "app"]),
    },
    async ({ formId }, ctx) => {
      if (!isFormId(formId)) return failure(NOT_FOUND(formId));
      const exists = await formStore(env, formId).exists();
      if (!exists) return failure(NOT_FOUND(formId));
      logEvent({ event: "form_loaded" });
      // The same stub shape as gather_decisions, and the same carrier decision:
      // "put this form back on screen" means nothing on a client with no
      // screen to put it on. The schema is NOT sent here either — the renderer
      // fetches it itself with get_form_state, because the host delivers only
      // tool input to the app.
      return stubFor(env, formId, origin, currentLogin(), {
        envelope: (ctx as { mcpReq?: { envelope?: unknown } })?.mcpReq?.envelope,
        handshake: server.server.getClientCapabilities(),
        clientInfo: server.server.getClientVersion(),
        userAgent,
      });
    },
  );

  /* ------------------------------- get_answers --------------------------- */

  /**
   * The PULL channel for answers, and the reason it exists is a field defect
   * rather than a design preference.
   *
   * §7.2's context discipline says the payload travels on
   * `ui/update-model-context` and `ui/message` carries only a receipt. That is
   * still the right division — a user-role message full of JSON is noise in the
   * conversation, and the app composing a user turn is the injection vector the
   * host makes the user confirm. But the context channel is advisory: the
   * extension's own contract is that the host "will typically defer" it to the
   * next user message, and a host that drops it silently leaves the agent
   * holding "form displayed" and nothing else, which is exactly what the first
   * field session saw. A push the agent cannot verify is not a channel.
   *
   * So: model-visible, text-only, no widget. §3's "the result is a stub" is not
   * violated — the rule exists so the SCHEMA is not paid for twice, and the
   * schema is not what comes back here. The answers are the thing the agent
   * asked for, and they come back once, when asked for.
   */
  server.registerTool(
    "get_answers",
    {
      title: "Get answers",
      description: GET_ANSWERS_DESCRIPTION,
      inputSchema: z.object({
        formId: z.string().describe("The id returned by gather_decisions."),
      }),
      _meta: textOnlyMeta,
    },
    async ({ formId }) => {
      if (!isFormId(formId)) return failure(NOT_FOUND(formId));
      const state: FormState | null = await formStore(env, formId).getState();
      if (!state) return failure(NOT_FOUND(formId));
      return answersReport(formId, state);
    },
  );

  /* ----------------------------- await_answers --------------------------- */

  /**
   * The other half of the link carrier (PROPOSAL-standalone-route.md §5).
   *
   * On the `ui://` carrier the app sends `ui/message` when the user submits:
   * a receipt lands in the conversation and the agent takes its turn. A web
   * page has no conversation to speak into, so the loop ended with the person
   * going back to their session and asking to have their own answers read —
   * which is precisely the busywork the form was supposed to remove.
   *
   * So the waiting moves to the server. The agent calls this the moment it
   * hands over a link; it returns the answers the instant they land.
   *
   * It waits in SHORT hops rather than one long block, because Claude Code
   * starts a per-request timer covering everything up to the server's first
   * response byte, and that timer is 60 seconds unless the server entry
   * configures otherwise. A single four-minute block would trip it. A hop that
   * answers inside the window and says "call me again" cannot, and the retry
   * costs the user nothing — they are filling in a form, not watching this.
   */
  server.registerTool(
    "await_answers",
    {
      title: "Await answers",
      description: AWAIT_ANSWERS_DESCRIPTION,
      inputSchema: z.object({
        formId: z.string().describe("The id returned by gather_decisions."),
        waitMs: z
          .number()
          .optional()
          .describe(
            "How long to wait before answering that nothing has arrived yet. Default 45000, capped at 55000.",
          ),
      }),
      _meta: textOnlyMeta,
    },
    async ({ formId, waitMs }) => {
      if (!isFormId(formId)) return failure(NOT_FOUND(formId));
      const store = formStore(env, formId);
      const deadline = Date.now() + Math.min(Math.max(waitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);

      for (;;) {
        const state: FormState | null = await store.getState();
        if (!state) return failure(NOT_FOUND(formId));
        if (state.submittedAt !== null) {
          logEvent({ event: "await_resolved" });
          return answersReport(formId, state);
        }
        if (Date.now() >= deadline) {
          logEvent({ event: "await_timeout" });
          const report = reportAnswers(state.form, state.answers);
          return {
            ...text(
              [
                `Not submitted yet — "${state.form.title}" is still open.`,
                report.answered > 0
                  ? `${report.answered} answer(s) saved so far, so they are filling it in.`
                  : "Nothing saved yet.",
                "",
                "Call await_answers again with the same formId to keep waiting. Do not ask the user whether they are done — this tool is what finds out.",
              ].join("\n"),
            ),
            structuredContent: { formId, submitted: false, answered: report.answered },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
  );

  /* ----------------------------- get_form_state -------------------------- */

  /**
   * visibility ["app"] ONLY, and the reason is a specific gap in the host
   * contract (§7.2): the host delivers `ui/notifications/tool-input` to the
   * app, i.e. the ARGUMENTS of the call that opened it. On `load_form` those
   * arguments are just `{ formId }` — the schema and the accumulated answers
   * are on the server. So a re-opened form has to pull its own state, and this
   * is the pull.
   *
   * The result shape is chosen to match what the bridge's tool-input handler
   * already accepts (packages/ui/src/host/bridge.ts): the envelope under
   * `form`, plus an `answers` map beside it, which is exactly what
   * `extractForm`/`extractAnswers` read. So step 5 can feed
   * `result.structuredContent` straight into `loadFromArguments` with no
   * reshaping.
   *
   * It travels in `structuredContent` and NOT in the text content: the payload
   * is the whole point of this call, and §7.5 notes results over ~150k
   * characters get spilled to a file pointer. One copy, in the structured slot.
   */
  server.registerTool(
    "get_form_state",
    {
      title: "Get form state",
      description: GET_FORM_STATE_DESCRIPTION,
      inputSchema: z.object({ formId: z.string() }),
      _meta: appOnlyMeta,
    },
    async ({ formId }) => {
      if (!isFormId(formId)) return failure(NOT_FOUND(formId));
      const state: FormState | null = await formStore(env, formId).getState();
      if (!state) return failure(NOT_FOUND(formId));
      const answerCount = Object.keys(state.answers).length;
      logEvent({ event: "state_served", count: answerCount });
      return {
        content: [
          {
            type: "text",
            text: `form ${formId}: ${state.form.sections.length} section(s), ${answerCount} stored answer(s).`,
          },
        ],
        structuredContent: {
          form: state.form,
          answers: state.answers,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          submittedAt: state.submittedAt,
          // §10 attribution. App-visible only, and it is the viewer's own
          // login in the single-user case — the renderer ignores it today, but
          // "who last wrote this" is the question the column exists to answer.
          updatedBy: state.updatedBy,
        },
      };
    },
  );

  /* ----------------------------- get_form_link --------------------------- */

  /**
   * The escape hatch for a client that mounts no UI.
   *
   * `gather_decisions` renders inline wherever the host supports MCP Apps. Where
   * it does not — Claude Code mounts no `ui://` resource at all — the tools
   * still run and the person sees nothing, which is exactly the failure the
   * second field session hit from the other direction. This mints a signed URL
   * for the same renderer, served as a page (PROPOSAL-standalone-route.md).
   *
   * Model-visible, because the model is who notices the form did not appear.
   * It mints rather than stores: a link is a capability with a clock on it, and
   * re-minting after 12 hours costs one round trip and no state.
   */
  server.registerTool(
    "get_form_link",
    {
      title: "Get form link",
      description: GET_FORM_LINK_DESCRIPTION,
      inputSchema: z.object({
        formId: z.string().describe("The id returned by gather_decisions."),
      }),
      _meta: textOnlyMeta,
    },
    async ({ formId }) => {
      if (!isFormId(formId)) return failure(NOT_FOUND(formId));
      if (!env.FORM_URL_SECRET) {
        // Fails closed and says which lever is loose — to the operator through
        // the log, and to the agent in words it can act on.
        logConfigError("form_url_secret_unset");
        return failure(
          "form links are not configured on this server (no signing key). Nothing is wrong with the form itself: its answers are still readable with get_answers once the user fills it in another client.",
        );
      }
      const state: FormState | null = await formStore(env, formId).getState();
      if (!state) return failure(NOT_FOUND(formId));

      const token = await mintFormToken(env.FORM_URL_SECRET, {
        formId,
        login: currentLogin() ?? "unknown",
      });
      if (!origin) {
        return failure(
          "this server cannot tell what its own address is on this transport, so it cannot mint a link. The form is unaffected: its answers are still readable with get_answers.",
        );
      }
      const url = formUrl(origin, token);
      logEvent({ event: "form_link_minted" });
      return {
        content: [
          {
            type: "text",
            text: `Open the form here — the link works for 12 hours:\n\n${url}\n\nWhen the user submits, read the answers with get_answers.`,
          },
        ],
        structuredContent: { url },
      };
    },
  );

  /* ------------------------------- save_draft ---------------------------- */

  /**
   * visibility ["app"] ONLY — §3's autosave transport. The iframe cannot POST
   * anywhere (`connect-src 'none'`), so drafts reach the server as an
   * app-visible tool call the host proxies. That is what keeps "the app cannot
   * phone home" literally true while still having autosave.
   *
   * `formId: null` is a first-class case, not a bug: on a FRESH
   * `gather_decisions` render the app only ever sees the tool input, which
   * carries the agent's envelope and no server-minted id. Until step 5 wires
   * the id through, the renderer sends null — so this answers politely instead
   * of erroring, and the renderer's give-up counter never trips.
   */
  server.registerTool(
    "save_draft",
    {
      title: "Save draft",
      description: SAVE_DRAFT_DESCRIPTION,
      inputSchema: z.object({
        formId: z.string().nullable(),
        answers: z.record(z.string(), z.unknown()),
        complete: z
          .boolean()
          .optional()
          .describe(
            "True only when `answers` is the whole answer map for the rendered view; paths absent from it are then deleted. Default false = incremental upsert.",
          ),
        submitted: z
          .boolean()
          .optional()
          .describe(
            "True on the submit flush only: this payload is what the user submitted. Stamps submittedAt once; implies `complete`.",
          ),
      }),
      _meta: appOnlyMeta,
    },
    async ({ formId, answers, complete, submitted }) => {
      if (formId === null) {
        return {
          content: [
            {
              type: "text",
              text: "no formId — this view has no server-side store, so nothing was saved. Answers still reach the model on submit.",
            },
          ],
          structuredContent: { ok: false, code: "no_form_id" },
        };
      }
      if (!isFormId(formId)) return failure(NOT_FOUND(formId), { ok: false, code: "not_found" });

      // Light shape check only (§6.3): the answer map is the user's data, not
      // an authored artefact, and a form whose schema is not to hand cannot be
      // resolved against anyway. Malformed VALUES are the renderer's gate.
      const shape = validateAnswers(answers);
      if (!shape.ok || !shape.answers) {
        return failure(shape.text, { ok: false, code: "malformed_answers" });
      }

      const result: SaveDraftResult = await formStore(env, formId).saveDraft({
        answers: shape.answers as Answers,
        updatedBy: currentLogin(),
        ...(complete === undefined ? {} : { complete }),
        ...(submitted === undefined ? {} : { submitted }),
      });

      if (result.ok) {
        return {
          content: [{ type: "text", text: `saved ${result.saved} path(s).` }],
          structuredContent: { ok: true, saved: result.saved, deleted: result.deleted },
        };
      }

      // A tool-level error, not a protocol error: the transport worked, the
      // write was refused. `structuredContent` carries the machine-readable
      // reason so the app can back off rather than count a failure.
      return failure(`draft not saved — ${result.message}`, {
        ok: false,
        code: result.code,
        ...(result.code === "throttled" ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.code === "too_large" ? { bytes: result.bytes, limit: result.limit } : {}),
      });
    },
  );

  return server;
}
