/**
 * The host bridge (§7.2) — everything that crosses the postMessage boundary.
 *
 * Context discipline is the rule that shapes this file: mid-fill pushes carry a
 * one-line SUMMARY and nothing else, the full structured payload goes over
 * exactly once, on submit. Drafts travel as an app-visible `tools/call`
 * (`save_draft`) because the iframe cannot POST anywhere — that is the point of
 * `connect-src 'none'` (§3), and it means autosave must tolerate the tool not
 * existing yet.
 */

import type { Answers } from "@gather/schema";
import { validateForm } from "@gather/schema";
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
  type InitializeResult,
  METHOD,
  PROTOCOL_VERSION,
  SAVE_DRAFT_TOOL,
  type ToolCallResult,
} from "./protocol.js";
import { RpcPeer } from "./rpc.js";
import type { Transport } from "./transport.js";

/** §7.2 — debounced progress summary. */
export const MODEL_CONTEXT_DEBOUNCE_MS = 2_000;
/** §3 — debounced draft write to the form's Durable Object. */
export const SAVE_DRAFT_DEBOUNCE_MS = 3_000;

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
  transport: Transport;
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
  flush: () => Promise<void>;
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
 * Both the bare `CallToolResult` and a `{ result: … }` wrapper are accepted:
 * hosts differ, and the cost of tolerating both is one line.
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
  const { store, transport } = options;
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
  let lastPartial: unknown = null;
  let unsubscribeStore: (() => void) | null = null;
  let observer: ResizeObserver | null = null;

  const peer = new RpcPeer(transport, {
    onNotification: (method, params) => handleNotification(method, params),
    onRequest: async (method) => {
      if (method === METHOD.teardown) {
        // A REQUEST, not a notification: the host waits, so the final draft
        // flush happens before we answer (§7.2).
        emit({ type: "teardown" });
        await flushComplete();
        frozen = true;
        contextPush.cancel();
        return {};
      }
      return {};
    },
  });

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
      await peer.request(METHOD.updateModelContext, {
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
    completeFlush = false;
    const answers = complete ? (currentSubmission()?.answers ?? state.answers) : state.answers;
    try {
      const result = await peer.request<ToolCallResult>(METHOD.toolsCall, {
        name: SAVE_DRAFT_TOOL,
        arguments: {
          formId: state.form.formId ?? knownFormId,
          answers,
          ...(complete ? { complete: true } : {}),
        },
      });
      const outcome = draftOutcome(result);
      switch (outcome.kind) {
        case "throttled":
          // The DO refused the PACE, not the payload: back off by exactly what
          // it asked for and try again. Not a failure — counting it would trip
          // the give-up counter on a form the user is simply filling fast.
          if (complete) completeFlush = true;
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
  const flushComplete = async (): Promise<void> => {
    completeFlush = true;
    await draftPush.flush({ force: store.getState().revision > 0 });
    completeFlush = false;
  };

  /* --------------------------- inbound handling --------------------------- */

  function loadFromArguments(args: unknown): void {
    store.getState().loadForm(extractForm(args));
    const answers = extractAnswers(args);
    if (answers && store.getState().status === "ready") store.getState().hydrate(answers);
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
      const result = await peer.request<ToolCallResult>(METHOD.toolsCall, {
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

  function handleNotification(method: string, params: unknown): void {
    const args = (params as { arguments?: unknown } | undefined)?.arguments;
    switch (method) {
      case METHOD.toolInput: {
        frozen = false;
        const reopened = loadFormId(args);
        if (reopened) {
          knownFormId = reopened;
          void hydrateFromServer(reopened);
        } else {
          loadFromArguments(args);
        }
        break;
      }
      case METHOD.toolInputPartial: {
        // Best-effort: buffer, and render only once the prefix validates. A
        // half-parsed schema must never flash a broken form (§6.3).
        lastPartial = args;
        const candidate = extractForm(lastPartial);
        if (validateForm(candidate).ok) loadFromArguments(lastPartial);
        break;
      }
      case METHOD.toolCancelled: {
        frozen = true;
        contextPush.cancel();
        draftPush.cancel();
        store.getState().cancel();
        emit({
          type: "cancelled",
          reason: (params as { reason?: string } | undefined)?.reason ?? "cancelled",
        });
        break;
      }
      case METHOD.hostContextChanged: {
        hostContext = mergeHostContext(hostContext, (params ?? {}) as HostContext);
        apply(hostContext);
        if (hostContext.displayMode && hostContext.displayMode !== "pip") {
          store.getState().setDisplayMode(hostContext.displayMode);
        }
        emit({ type: "context", context: hostContext });
        break;
      }
      case METHOD.toolResult: {
        // The result is a stub by design (§3) — nothing to RENDER. But the stub
        // carries the server-minted formId, and on a fresh render that is the
        // only place the app can learn it, so `save_draft` stops sending null.
        const learned = resultFormId(params);
        if (learned) knownFormId = learned;
        break;
      }
      default:
        break;
    }
  }

  /* -------------------------------- public -------------------------------- */

  const reportSize = (width: number, height: number): void => {
    if (frozen) return;
    // Inline auto-fit only: in fullscreen the viewport is ours (§7.3).
    if (store.getState().displayMode !== "inline") return;
    peer.notify(METHOD.sizeChanged, { width, height });
  };

  return {
    async start() {
      const result = await peer.request<InitializeResult>(METHOD.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: APP_INFO,
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      });
      hostContext = result?.hostContext ?? {};
      apply(hostContext);
      if (hostContext.displayMode && hostContext.displayMode !== "pip") {
        store.getState().setDisplayMode(hostContext.displayMode);
      }
      emit({ type: "context", context: hostContext });
      peer.notify(METHOD.initialized, {});

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
      await flushComplete();
      // Full structured answers travel here, once (§7.2); `ui/message` is what
      // triggers the turn.
      try {
        await peer.request(METHOD.updateModelContext, {
          content: [{ type: "text", text: summaryLine(state.form, submission.summary) }],
          structuredContent: submission as unknown as Record<string, unknown>,
        });
      } catch {
        // Fall through: the message below still carries the payload.
      }
      await peer.request(METHOD.message, {
        role: "user",
        content: {
          type: "text",
          text: `${summaryLine(state.form, submission.summary)}\n\n${JSON.stringify(submission)}`,
        },
      });
      emit({ type: "submitted", submission });
      return submission;
    },

    async requestDisplayMode(mode) {
      try {
        const result = await peer.request<{ mode?: DisplayModeName }>(METHOD.requestDisplayMode, {
          mode,
        });
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
      peer.close();
      transport.stop();
    },
  };
}
