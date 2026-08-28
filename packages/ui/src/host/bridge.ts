/**
 * The host bridge (§7.2) — everything that crosses the postMessage boundary.
 *
 * The WIRE is not ours: `@modelcontextprotocol/ext-apps`' `App` owns the
 * handshake, the JSON-RPC framing and every message shape, so what this file
 * still owns is the etiquette above it. That etiquette is the whole point:
 * mid-fill pushes carry a one-line SUMMARY and nothing else, the full
 * structured payload goes over exactly once, on submit. Drafts travel as an
 * app-visible `tools/call` (`save_draft`) because the iframe cannot POST
 * anywhere — that is what `connect-src 'none'` means (§3), and it means
 * autosave must tolerate the tool not existing yet.
 */

import type { Answers } from "@mcpq/schema";
import { validateForm } from "@mcpq/schema";
import { App } from "@modelcontextprotocol/ext-apps";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildSubmission,
  type EngineStore,
  type Submission,
  summaryLine,
} from "../engine/index.js";
import { applyHostContext, mergeHostContext } from "./dom.js";
import {
  APP_INFO,
  type DisplayModeName,
  GET_FORM_STATE_TOOL,
  type HostContext,
  SAVE_DRAFT_TOOL,
  type ToolCallResult,
} from "./protocol.js";

/** §7.2 — debounced progress summary. */
export const MODEL_CONTEXT_DEBOUNCE_MS = 2_000;
/** §3 — debounced draft write to the form's Durable Object. */
export const SAVE_DRAFT_DEBOUNCE_MS = 3_000;
/**
 * §6.3 — how long a form attempt that does not validate is given to become one
 * before the app says so.
 *
 * The partial channel was always patient: a brace-healed prefix renders nothing
 * and waits. But not every host streams a form on `tool-input-partial` — some
 * deliver growing arguments on `tool-input` itself, and the last thing a person
 * should watch while the agent is still writing their form is "this form could
 * not be rendered", replaced a second later by the form. The invalid state is
 * for a schema the agent got WRONG, not for one it has not finished.
 *
 * Waiting costs nothing real: `gather_decisions` validates server-side before
 * it stores anything, so a genuinely malformed envelope is being rejected with
 * teaching errors on that path anyway, and the agent is already on its way to a
 * second attempt. What the delay buys is that the sentence only ever appears
 * when it is true and final.
 */
export const INVALID_GRACE_MS = 800;

/** After this many consecutive failures we stop trying (the tool may not exist). */
const SAVE_DRAFT_GIVE_UP_AFTER = 3;

export type DraftOutcome =
  | { kind: "saved" }
  /** Refused for pace, not for content: back off, and do NOT count a failure. */
  | { kind: "throttled"; retryAfterMs: number }
  /** Refused for content: retrying cannot help, so stop and say so. */
  | { kind: "too_large"; message: string }
  /** No server-side store for this view (`formId: null`) — a non-event (§3). */
  | { kind: "no_store" }
  | { kind: "failed" };

export type BridgeEvent =
  | { type: "context"; context: HostContext }
  | { type: "cancelled"; reason: string }
  | { type: "teardown" }
  | { type: "draft"; ok: boolean; outcome: DraftOutcome }
  | { type: "submitted"; submission: Submission };

export type BridgeOptions = {
  /**
   * An SDK transport. Omitted in the bundle, where the SDK's own default —
   * `new PostMessageTransport(window.parent, window.parent)`, i.e. "talk to
   * whatever framed us" — is exactly right. The tests and the dev harness pass
   * one, and the app cannot tell the difference. That is the point.
   */
  transport?: Transport;
  store: EngineStore;
  /** Called for every host-context change, so React can re-render on theme. */
  onEvent?: (event: BridgeEvent) => void;
  /** Overridable for tests; defaults to writing to `document`. */
  applyContext?: (context: HostContext) => void;
  modelContextDebounceMs?: number;
  saveDraftDebounceMs?: number;
};

export type Bridge = {
  /** Runs the §7.2 handshake and starts listening. */
  start: () => Promise<HostContext>;
  hostContext: () => HostContext;
  /** Submit: full structured payload, then the turn-triggering message. */
  submit: () => Promise<Submission | null>;
  requestDisplayMode: (mode: DisplayModeName) => Promise<DisplayModeName | null>;
  /** Inline auto-fit (§7.3). No-op in fullscreen — the viewport is ours. */
  reportSize: (width: number, height: number) => void;
  observe: (element: Element) => () => void;
  /** Flushes the whole rendered view as a `complete` draft. Awaited by teardown. */
  flush: (options?: { submitted?: boolean }) => Promise<void>;
  /** The server-minted formId, once it is known (§3). */
  formId: () => string | null;
  frozen: () => boolean;
  stop: () => void;
};

type Debounced = {
  /** `delayMs` overrides the default — how a throttled draft backs off. */
  schedule: (delayMs?: number) => void;
  cancel: () => void;
  /** `force` fires even with nothing pending (the submit/teardown snapshot). */
  flush: (options?: { force?: boolean }) => Promise<void>;
};

function debounce(run: () => Promise<void> | void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const fire = async (): Promise<void> => {
    timer = undefined;
    if (!pending) return;
    pending = false;
    await run();
  };
  return {
    schedule(delayMs = ms) {
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
    async flush(options) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (options?.force) pending = true;
      await fire();
    },
  };
}

/**
 * Whether these tool arguments are an ATTEMPT at a form.
 *
 * Only `gather_decisions` and `load_form` carry `_meta.ui.resourceUri`, so only
 * they should ever mount this app — but "should" is the host's promise, not
 * ours, and the first field session watched a text tool's `{archetype}` land
 * here and render "this form could not be rendered" to the user. That card
 * accuses the agent of writing a bad schema; on someone else's tool input it is
 * a lie, and a loud one.
 *
 * So the app decides for itself whether it was handed a form. The test is
 * STRUCTURAL and generous — the envelope bare, the envelope under `form`, a
 * `formId` to pull by, or the two properties every envelope has (§4) — because
 * the validator is still the only thing that judges a form's contents. What
 * fails this test is not a bad form; it is not a form.
 */
export function isFormAttempt(args: unknown): boolean {
  const args_ = record(args);
  if (!args_) return false;
  if (Array.isArray(args_.sections)) return true;
  if (record(args_.form)) return true;
  if (typeof args_.formId === "string" && args_.formId.length > 0) return true;
  return "version" in args_ && "title" in args_;
}

/**
 * Finds the form in the tool arguments. The MCP `inputSchema` is loose (§6.3),
 * and the Worker is free to send the envelope either bare or wrapped, so both
 * are accepted; the validator is the only gate that matters.
 */
export function extractForm(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const record = args as Record<string, unknown>;
  if (Array.isArray(record.sections)) return record;
  if (typeof record.form === "object" && record.form !== null) return record.form;
  return record;
}

/** A draft the Worker replayed alongside the schema (`load_form`, §3). */
function extractAnswers(args: unknown): Answers | null {
  if (typeof args !== "object" || args === null) return null;
  const answers = (args as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  return answers as Answers;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A `load_form` render, detected from its own tool input.
 *
 * The host delivers only tool INPUT to the app (§7.2), and `load_form`'s input
 * is `{ formId }` and nothing else — the schema and the accumulated answers are
 * on the server. So this shape means "pull your own state" rather than "here is
 * a form", and it is distinguished by what is ABSENT: no `sections`, no `form`.
 */
export function loadFormId(args: unknown): string | null {
  const args_ = record(args);
  if (!args_) return null;
  if (typeof args_.formId !== "string" || args_.formId.length === 0) return null;
  if (Array.isArray(args_.sections)) return null;
  if (record(args_.form)) return null;
  return args_.formId;
}

/**
 * The formId out of `ui/notifications/tool-result`.
 *
 * The result is a stub by design (§3) — but the stub's `structuredContent`
 * carries the server-minted id, and per §7.1 `structuredContent` is not added to
 * model context, so this is the ONE channel by which a fresh `gather_decisions`
 * render learns which store it is autosaving into. Ignoring it is what made
 * `save_draft` send `formId: null` forever.
 *
 * The extension defines this notification's params as a bare `CallToolResult`,
 * which is what the SDK now hands us. The `{ result: … }` wrapper is still
 * tolerated: hosts differ, and the cost of accepting both is one line.
 */
export function resultFormId(params: unknown): string | null {
  const outer = record(params);
  if (!outer) return null;
  const candidates = [outer, record(outer.result)].filter(
    (entry): entry is Record<string, unknown> => entry !== null,
  );
  for (const candidate of candidates) {
    const structured = record(candidate.structuredContent);
    const formId = structured?.formId;
    if (typeof formId === "string" && formId.length > 0) return formId;
  }
  return null;
}

/**
 * Reads the `save_draft` result's machine-readable verdict (§3). The Worker
 * answers a refused write with `isError` and a closed `code`, precisely so the
 * app can tell "slow down" from "this will never work" from "the tool is not
 * there at all" — three different things that a bare rejection collapses.
 */
export function draftOutcome(result: ToolCallResult | undefined): DraftOutcome {
  const structured = result?.structuredContent;
  if (!structured) return result?.isError ? { kind: "failed" } : { kind: "saved" };
  if (structured.ok === true) return { kind: "saved" };
  const code = structured.code;
  if (code === "throttled") {
    const retryAfterMs = structured.retryAfterMs;
    return {
      kind: "throttled",
      retryAfterMs: typeof retryAfterMs === "number" && retryAfterMs > 0 ? retryAfterMs : 1_000,
    };
  }
  if (code === "too_large") {
    const bytes = structured.bytes;
    const limit = structured.limit;
    const size =
      typeof bytes === "number" && typeof limit === "number"
        ? ` (${Math.round(bytes / 1024)} kB against a ${Math.round(limit / 1024)} kB cap)`
        : "";
    return {
      kind: "too_large",
      message: `Too much to autosave${size} — your answers are safe on screen and still reach me on submit.`,
    };
  }
  if (code === "no_form_id") return { kind: "no_store" };
  return { kind: "failed" };
}

export function createBridge(options: BridgeOptions): Bridge {
  const { store } = options;
  const apply = options.applyContext ?? applyHostContext;
  const emit = (event: BridgeEvent): void => options.onEvent?.(event);

  let hostContext: HostContext = {};
  let frozen = false;
  let saveDraftFailures = 0;
  /** `too_large`: retrying an oversized payload cannot help, so we stop. */
  let saveDraftStopped = false;
  /**
   * The server-minted formId, learned from the tool result or from a
   * `load_form` input. The form envelope carries it once the schema came from
   * `get_form_state`; on a fresh render it exists only here.
   */
  let knownFormId: string | null = null;
  /** Set for the next push only: the submit and teardown snapshots (§3). */
  let completeFlush = false;
  /**
   * Set for the submit snapshot only. It is what turns the stored draft into a
   * submitted one, and it is the difference `get_answers` reports back to the
   * agent — "these are the answers" versus "these are the answers so far".
   */
  let submittedFlush = false;
  let lastPartial: unknown = null;
  let pendingInvalid: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let observer: ResizeObserver | null = null;

  /**
   * `autoResize: false` is deliberate. The SDK's own auto-resize observes
   * `documentElement` and `body` and reports unconditionally; §7.3 says the app
   * reports its height ONLY inline, because in fullscreen the viewport belongs
   * to us and a height report would fight the host for it. So `observe()` below
   * keeps our ResizeObserver, which measures the element we hand it and routes
   * through the display-mode gate in `reportSize`.
   */
  const app = new App(
    APP_INFO,
    { availableDisplayModes: ["inline", "fullscreen"] },
    {
      autoResize: false,
    },
  );

  /* ---------------------------- outbound pushes --------------------------- */

  const currentSubmission = (): Submission | null => {
    const state = store.getState();
    if (!state.form || state.status !== "ready") return null;
    return buildSubmission(state.form, state.answers, state.effects, state.prefill, {
      rows: state.rows,
      leaves: state.leaves,
    });
  };

  const contextPush = debounce(async () => {
    if (frozen) return;
    const state = store.getState();
    const submission = currentSubmission();
    if (!submission || !state.form) return;
    try {
      await app.updateModelContext({
        content: [{ type: "text", text: summaryLine(state.form, submission.summary) }],
      });
    } catch {
      // A host that refuses the push is not a reason to break the form.
    }
  }, options.modelContextDebounceMs ?? MODEL_CONTEXT_DEBOUNCE_MS);

  /**
   * The draft write (§3).
   *
   * `complete: true` rides on the submit and teardown snapshots ONLY, and it
   * carries the WHOLE rendered view — every leaf, hidden ones as `empty` — for
   * exactly the reason the Worker documents: on a complete write, paths absent
   * from the payload are deleted, which is what reconciles a store whose user
   * has since hidden or cleared something. An incremental autosave is an
   * upsert of what the store holds and must never claim to be the whole view,
   * or a mid-fill save would delete every path the user has not reached.
   */
  const draftPush = debounce(async () => {
    if (frozen || saveDraftStopped || saveDraftFailures >= SAVE_DRAFT_GIVE_UP_AFTER) return;
    const state = store.getState();
    if (!state.form || state.status !== "ready") return;
    const complete = completeFlush;
    const submitted = submittedFlush;
    completeFlush = false;
    submittedFlush = false;
    const answers = complete ? (currentSubmission()?.answers ?? state.answers) : state.answers;
    try {
      const result = await app.callServerTool({
        name: SAVE_DRAFT_TOOL,
        arguments: {
          formId: state.form.formId ?? knownFormId,
          answers,
          ...(complete ? { complete: true } : {}),
          ...(submitted ? { submitted: true } : {}),
        },
      });
      const outcome = draftOutcome(result);
      switch (outcome.kind) {
        case "throttled":
          // The DO refused the PACE, not the payload: back off by exactly what
          // it asked for and try again. Not a failure — counting it would trip
          // the give-up counter on a form the user is simply filling fast.
          if (complete) completeFlush = true;
          if (submitted) submittedFlush = true;
          draftPush.schedule(outcome.retryAfterMs);
          break;
        case "too_large":
          saveDraftStopped = true;
          store.getState().setDraftStatus(outcome.message);
          break;
        case "failed":
          saveDraftFailures += 1;
          break;
        default:
          saveDraftFailures = 0;
          store.getState().setDraftStatus(null);
          break;
      }
      emit({ type: "draft", ok: outcome.kind === "saved", outcome });
    } catch {
      // The Worker may not exist yet, or the host may not expose the tool.
      // Tolerated silently; after a few refusals we stop asking.
      saveDraftFailures += 1;
      emit({ type: "draft", ok: false, outcome: { kind: "failed" } });
    }
  }, options.saveDraftDebounceMs ?? SAVE_DRAFT_DEBOUNCE_MS);

  /**
   * The whole-view flush. Forced only when the user has actually changed
   * something: a complete write on an untouched form would spend a round trip
   * to say nothing.
   */
  const flushComplete = async (options: { submitted?: boolean } = {}): Promise<void> => {
    completeFlush = true;
    if (options.submitted) submittedFlush = true;
    // A submit is forced even on an untouched form: "I accept every prefilled
    // value as it stands" is a real answer, and it is the one a fully prefilled
    // plan_confirmation exists to collect (§5.4).
    await draftPush.flush({ force: options.submitted === true || store.getState().revision > 0 });
    completeFlush = false;
    submittedFlush = false;
  };

  /* --------------------------- inbound handling --------------------------- */

  /**
   * The two pieces of host context the RENDERER (not the stylesheet) branches
   * on: the display mode, which the host owns outright (§7.3), and the
   * platform, which decides whether a dense grid is editable at all.
   */
  function adoptContext(): void {
    if (hostContext.displayMode && hostContext.displayMode !== "pip") {
      store.getState().setDisplayMode(hostContext.displayMode);
    }
    if (hostContext.platform) store.getState().setPlatform(hostContext.platform);
  }

  function loadFromArguments(args: unknown): void {
    store.getState().loadForm(extractForm(args));
    const answers = extractAnswers(args);
    if (answers && store.getState().status === "ready") store.getState().hydrate(answers);
  }

  /** Any newer input, cancellation or teardown outranks a scheduled verdict. */
  function clearPendingInvalid(): void {
    if (pendingInvalid === null) return;
    clearTimeout(pendingInvalid);
    pendingInvalid = null;
  }

  /**
   * The one door every form schema comes through, partial or final (§6.3).
   *
   * Validates first: anything that parses renders immediately, which is the
   * common case and the fast one. Anything that does not is treated as "not yet"
   * — silently while more may arrive, and after INVALID_GRACE_MS on the final
   * channel, where nothing more is expected. The app stays on its skeletons in
   * the meantime, so a form still being written looks like a form still being
   * written.
   */
  function applyToolInput(args: unknown, final: boolean): void {
    clearPendingInvalid();
    const candidate = extractForm(args);
    if (validateForm(candidate).ok) {
      loadFromArguments(args);
      return;
    }
    // A prefix is not a defect. Say nothing and let the next chunk decide.
    if (!final) return;
    pendingInvalid = setTimeout(() => {
      pendingInvalid = null;
      // `loadForm` is what sets `invalid` and carries the diagnostics with it.
      store.getState().loadForm(candidate);
    }, INVALID_GRACE_MS);
  }

  /**
   * The `load_form` path (§7.2): the input named a form and nothing else, so we
   * pull the schema and the accumulated answers ourselves through the
   * app-visible `get_form_state`. Its `structuredContent` is `{ form, answers,
   * … }` — deliberately the shape `loadFromArguments` already accepts, so
   * nothing is reshaped here.
   */
  async function hydrateFromServer(formId: string): Promise<void> {
    try {
      const result = await app.callServerTool({
        name: GET_FORM_STATE_TOOL,
        arguments: { formId },
      });
      if (!result || result.isError || !result.structuredContent) {
        // Stay on the skeletons rather than flashing a wrong form, and say why.
        store
          .getState()
          .setDraftStatus(
            "This form could not be reopened — it may have expired. Ask me in chat and I will render a fresh one.",
          );
        return;
      }
      loadFromArguments(result.structuredContent);
    } catch {
      store
        .getState()
        .setDraftStatus(
          "This form could not be reopened. Ask me in chat and I will render it again.",
        );
    }
  }

  /*
   * Handlers are registered HERE, at construction, and never after `connect()`:
   * the host may fire `tool-input` the instant it sees
   * `ui/notifications/initialized`, and the SDK warns (and will one day throw)
   * about a one-shot handler registered late.
   */

  app.addEventListener("toolinput", (params) => {
    frozen = false;
    const args = params.arguments;
    if (!isFormAttempt(args)) {
      // Not our tool's input. Draw nothing, say nothing (see `isFormAttempt`).
      clearPendingInvalid();
      store.getState().noForm();
      return;
    }
    const reopened = loadFormId(args);
    if (reopened) {
      clearPendingInvalid();
      knownFormId = reopened;
      void hydrateFromServer(reopened);
    } else {
      applyToolInput(args, true);
    }
  });

  app.addEventListener("toolinputpartial", (params) => {
    // Best-effort: buffer, and render only once the prefix validates. Partial
    // arguments are brace-HEALED JSON, so a half-parsed schema is not merely
    // incomplete, it can be wrong — and must never flash a broken form (§6.3).
    lastPartial = params.arguments;
    applyToolInput(lastPartial, false);
  });

  app.addEventListener("toolresult", (params) => {
    // The result is a stub by design (§3) — nothing to RENDER. But the stub
    // carries the server-minted formId, and on a fresh render that is the
    // only place the app can learn it, so `save_draft` stops sending null.
    const learned = resultFormId(params);
    if (learned) knownFormId = learned;
  });

  app.addEventListener("toolcancelled", (params) => {
    frozen = true;
    // The agent stopped mid-schema: that is a cancellation, not a bad form.
    clearPendingInvalid();
    contextPush.cancel();
    draftPush.cancel();
    store.getState().cancel();
    emit({ type: "cancelled", reason: params.reason ?? "cancelled" });
  });

  app.addEventListener("hostcontextchanged", (params) => {
    // The SDK merges the patch into its own copy SHALLOWLY, which would drop a
    // palette when a theme-only patch arrives. Ours is the merged copy that
    // matters, and `mergeHostContext` merges `styles.variables` properly.
    hostContext = mergeHostContext(hostContext, params);
    apply(hostContext);
    adoptContext();
    emit({ type: "context", context: hostContext });
  });

  /**
   * Teardown is a REQUEST, not a notification: the host waits for our response,
   * so the final draft flush completes before the view is unmounted (§7.2).
   */
  app.onteardown = async () => {
    emit({ type: "teardown" });
    await flushComplete();
    frozen = true;
    clearPendingInvalid();
    contextPush.cancel();
    return {};
  };

  /* -------------------------------- public -------------------------------- */

  const reportSize = (width: number, height: number): void => {
    if (frozen) return;
    // Inline auto-fit only: in fullscreen the viewport is ours (§7.3).
    if (store.getState().displayMode !== "inline") return;
    try {
      void app.sendSizeChanged({ width, height });
    } catch {
      // Not connected yet, or already closed. A size report is never worth a throw.
    }
  };

  return {
    async start() {
      await app.connect(options.transport);
      hostContext = app.getHostContext() ?? {};
      apply(hostContext);
      adoptContext();
      emit({ type: "context", context: hostContext });

      let revision = store.getState().revision;
      unsubscribeStore = store.subscribe((state) => {
        if (state.revision === revision) return;
        revision = state.revision;
        if (frozen) return;
        contextPush.schedule();
        draftPush.schedule();
      });
      return hostContext;
    },

    hostContext: () => hostContext,

    async submit() {
      const state = store.getState();
      const submission = currentSubmission();
      if (!submission || !state.form) return null;
      contextPush.cancel();
      // The submit flush is what stamps the stored draft as submitted, and it
      // is awaited BEFORE the receipt goes out: the receipt tells the agent to
      // read the answers, so they had better be written first.
      await flushComplete({ submitted: true });
      // Full structured answers travel here too, once (§7.2). Kept, but no
      // longer RELIED on: it is a push the app cannot verify — see the receipt
      // below, and `get_answers` on the Worker.
      try {
        await app.updateModelContext({
          content: [{ type: "text", text: summaryLine(state.form, submission.summary) }],
          structuredContent: submission as unknown as Record<string, unknown>,
        });
      } catch {
        // A host that refuses the push is not a reason to break the submit.
      }
      // `content` is an ARRAY of content blocks. The hand-rolled layer sent a
      // single block here and every strict host rejected the submit.
      //
      // The text is a human-readable receipt — `ui/message` lands VISIBLY in
      // the conversation, and the host asks the user to confirm it before it
      // sends, so raw JSON here is both noise and an unreviewable payload. It
      // says one legible thing and hands the agent a POINTER instead: the
      // formId, and the tool that reads the answers back out of the store.
      //
      // That pointer is the fix for the defect the first field session could
      // not see past. The context channel above is ADVISORY — the extension's
      // own contract is that the host "will typically defer" it to the next
      // user message — so an agent relying on it alone can end up holding
      // "form displayed" and not one answer, which is what happened. A pull the
      // agent makes itself cannot be silently dropped.
      //
      // JSON rides along only when there is no formId to point at: a view with
      // no server-side store (§3), where the pull does not exist.
      const formId = state.form.formId ?? knownFormId;
      /**
       * One sentence, because a person is asked to vouch for it.
       *
       * This is a USER-role message the app composes, which is why the host
       * shows it for confirmation (§3). It used to carry the answer counts and
       * an instruction — "Read them with get_answers(formId: …)" — which read
       * as a work order addressed past the user rather than a receipt they
       * were signing. The agent does not need telling: get_answers is
       * described as the only way answers reach it, and the id is right here.
       *
       * The id stays. The agent has it from the gather_decisions stub, but not
       * after a compaction, not in a later session (a form outlives the
       * conversation that made it), and not unambiguously when two forms are
       * open.
       *
       * The counts went with it and are not missed: get_answers reports them,
       * and the one that used to look load-bearing — how many inferences went
       * unreviewed — is gone from the model's side entirely. A guess the user
       * left standing is their answer (see SubmissionSummary).
       */
      const receipt = formId
        ? `Submitted “${state.form.title}” (${formId})`
        : `Submitted “${state.form.title}”.\n\n${JSON.stringify(submission)}`;
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: receipt }],
      });
      emit({ type: "submitted", submission });
      return submission;
    },

    async requestDisplayMode(mode) {
      try {
        const result = await app.requestDisplayMode({ mode });
        const granted = result?.mode ?? mode;
        if (granted !== "pip") store.getState().setDisplayMode(granted);
        return granted;
      } catch {
        return null;
      }
    },

    reportSize,

    observe(element) {
      if (typeof ResizeObserver === "undefined") return () => {};
      observer?.disconnect();
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const box = entry.borderBoxSize?.[0];
        const width = box?.inlineSize ?? entry.contentRect.width;
        const height = box?.blockSize ?? entry.contentRect.height;
        reportSize(Math.ceil(width), Math.ceil(height));
      });
      observer.observe(element);
      return () => observer?.disconnect();
    },

    flush: flushComplete,

    formId: () => store.getState().form?.formId ?? knownFormId,

    frozen: () => frozen,

    stop() {
      contextPush.cancel();
      draftPush.cancel();
      unsubscribeStore?.();
      observer?.disconnect();
      void app.close();
    },
  };
}
