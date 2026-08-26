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
  type HostContext,
  type InitializeResult,
  METHOD,
  PROTOCOL_VERSION,
  SAVE_DRAFT_TOOL,
} from "./protocol.js";
import { RpcPeer } from "./rpc.js";
import type { Transport } from "./transport.js";

/** §7.2 — debounced progress summary. */
export const MODEL_CONTEXT_DEBOUNCE_MS = 2_000;
/** §3 — debounced draft write to the form's Durable Object. */
export const SAVE_DRAFT_DEBOUNCE_MS = 3_000;

/** After this many consecutive failures we stop trying (the tool may not exist). */
const SAVE_DRAFT_GIVE_UP_AFTER = 3;

export type BridgeEvent =
  | { type: "context"; context: HostContext }
  | { type: "cancelled"; reason: string }
  | { type: "teardown" }
  | { type: "draft"; ok: boolean }
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
  /** Flushes a pending draft write. Awaited by teardown. */
  flush: () => Promise<void>;
  frozen: () => boolean;
  stop: () => void;
};

type Debounced = { schedule: () => void; cancel: () => void; flush: () => Promise<void> };

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
    schedule() {
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
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

export function createBridge(options: BridgeOptions): Bridge {
  const { store, transport } = options;
  const apply = options.applyContext ?? applyHostContext;
  const emit = (event: BridgeEvent): void => options.onEvent?.(event);

  let hostContext: HostContext = {};
  let frozen = false;
  let saveDraftFailures = 0;
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
        await draftPush.flush();
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

  const draftPush = debounce(async () => {
    if (frozen || saveDraftFailures >= SAVE_DRAFT_GIVE_UP_AFTER) return;
    const state = store.getState();
    if (!state.form || state.status !== "ready") return;
    try {
      await peer.request(METHOD.toolsCall, {
        name: SAVE_DRAFT_TOOL,
        arguments: { formId: state.form.formId ?? null, answers: state.answers },
      });
      saveDraftFailures = 0;
      emit({ type: "draft", ok: true });
    } catch {
      // The Worker may not exist yet, or the host may not expose the tool.
      // Tolerated silently; after a few refusals we stop asking.
      saveDraftFailures += 1;
      emit({ type: "draft", ok: false });
    }
  }, options.saveDraftDebounceMs ?? SAVE_DRAFT_DEBOUNCE_MS);

  /* --------------------------- inbound handling --------------------------- */

  function loadFromArguments(args: unknown): void {
    store.getState().loadForm(extractForm(args));
    const answers = extractAnswers(args);
    if (answers && store.getState().status === "ready") store.getState().hydrate(answers);
  }

  function handleNotification(method: string, params: unknown): void {
    const args = (params as { arguments?: unknown } | undefined)?.arguments;
    switch (method) {
      case METHOD.toolInput:
        frozen = false;
        loadFromArguments(args);
        break;
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
      case METHOD.toolResult:
        // The result is a stub by design (§3) — nothing to render.
        break;
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
      await draftPush.flush();
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

    flush: () => draftPush.flush(),

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
