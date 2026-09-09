/**
 * The standalone carrier — the same renderer, served as an ordinary page.
 *
 * Claude Code mounts no `ui://` resource (PROPOSAL-standalone-route.md §1), so
 * for that carrier the form is a page the Worker serves and the person opens:
 * in the desktop Browser pane, through URL-mode elicitation, or from a plain
 * link. Everything above this file is untouched — `App`, the engine, the
 * fields, the validator — because {@link Bridge} is the only thing that differs
 * between a form inside a host and a form in a tab.
 *
 * Three things change, and only these three:
 *
 *  - The schema does not arrive over a handshake. It is inlined in the page by
 *    the Worker, so `start()` has it before the first paint and there is no
 *    partial-input channel to be patient about.
 *  - Drafts POST to our own origin instead of travelling as an app-visible
 *    `save_draft` tool call. §3 routed them through the host only because
 *    `connect-src 'none'` left the iframe unable to POST anywhere; the page we
 *    serve ourselves runs under `connect-src 'self'` (§8 Q1), and the DO stays
 *    the store either way. The WIRE differs; the destination does not.
 *  - There is no conversation to send a receipt into. `ui/message` has no
 *    counterpart here, so the submit ends on screen and the agent learns the
 *    answers the way it always should have: by calling `get_answers` itself.
 *
 * What deliberately does NOT change is the payload contract. The Worker's HTTP
 * route answers with the same `{ ok, code, retryAfterMs, … }` verdict that
 * `save_draft` returns, so {@link draftOutcome} reads both, and "slow down"
 * stays distinguishable from "this will never work" on either carrier.
 */

import type { Answers } from "@mcpq/schema";
import type { EngineStore, Submission } from "../engine/index.js";
import {
  type Bridge,
  type BridgeEvent,
  currentSubmission,
  type DraftOutcome,
  debounce,
  draftOutcome,
  extractForm,
  SAVE_DRAFT_DEBOUNCE_MS,
  SAVE_DRAFT_GIVE_UP_AFTER,
} from "./bridge.js";
import { applyHostContext } from "./dom.js";
import type { HostContext, ToolCallResult } from "./protocol.js";

/**
 * What the Worker inlines into the page.
 *
 * `form` is the envelope exactly as `gather_decisions` received it, so
 * `extractForm` accepts it bare or wrapped without reshaping — the same
 * generosity the host carrier needs, for the same reason.
 */
export type StandaloneBootstrap = {
  form: unknown;
  /** The server-minted id (§3). Null only for a view with no store. */
  formId: string | null;
  /** Answers already in the DO — a reopened draft. */
  answers?: Answers | null;
  /** Where drafts and the submit go. Same origin, always. */
  endpoint: string;
  /** A form the DO already has a submit for: render it read-only. */
  submitted?: boolean;
};

export type StandaloneBridgeOptions = {
  store: EngineStore;
  bootstrap: StandaloneBootstrap;
  onEvent?: (event: BridgeEvent) => void;
  /** Overridable for tests; defaults to writing to `document`. */
  applyContext?: (context: HostContext) => void;
  saveDraftDebounceMs?: number;
  /** Injected in tests. Defaults to the page's own `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * The message the person sees once their answers are stored.
 *
 * It travels on the draft-status line — the same one-line plumbing channel the
 * host carrier uses (§3) — because that line already exists in the action bar
 * and nothing above the bridge has to learn a new state. It says where the
 * answers went and what to do next, and it does NOT say "get_answers": that is
 * an instruction addressed past the reader, and the agent needs no telling.
 */
export const SUBMITTED_NOTICE = "Answers saved. You can return to your session — I have them.";

/** Sent when the page could not reach the Worker at all. */
export const OFFLINE_NOTICE =
  "Your answers are safe on screen, but I could not save them just now. Leave this tab open and try submitting again.";

/**
 * Reads an HTTP verdict as the tool-call result {@link draftOutcome} expects.
 *
 * The Worker returns the save_draft `structuredContent` as the body, so the two
 * carriers share one verdict vocabulary. A response that is not JSON at all —
 * an HTML error page from somewhere in front of the Worker, say — is a failure,
 * not a crash.
 */
async function verdictOf(response: Response): Promise<ToolCallResult> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return { content: [], structuredContent: body, isError: !response.ok };
  } catch {
    return { content: [], isError: true };
  }
}

/** The element the Worker writes the bootstrap into (see index.html). */
export const BOOTSTRAP_ID = "mcpq-bootstrap";

/**
 * The bootstrap the Worker inlined, or null when this is the `ui://` carrier.
 *
 * Which carrier the bundle is on is decided HERE and nowhere else: a page the
 * Worker served has a bootstrap, a resource a host mounted does not. Parsing is
 * forgiving in one direction only — anything unreadable means "no form", which
 * the app already draws as an empty state. It must never throw, because a blank
 * page tells the person nothing about what went wrong.
 */
export function readBootstrap(): StandaloneBootstrap | null {
  if (typeof document === "undefined") return null;
  const element = document.getElementById(BOOTSTRAP_ID);
  if (!element?.textContent) return null;
  try {
    const parsed = JSON.parse(element.textContent) as StandaloneBootstrap | null;
    if (!parsed || typeof parsed !== "object" || !("form" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createStandaloneBridge(options: StandaloneBridgeOptions): Bridge {
  const { store, bootstrap } = options;
  const apply = options.applyContext ?? applyHostContext;
  const emit = (event: BridgeEvent): void => options.onEvent?.(event);
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  /**
   * A tab is fullscreen by definition (§7.3), and it is the only display mode
   * this carrier can offer — so the app is told once, at the start, and never
   * asked to negotiate.
   */
  const hostContext: HostContext = { displayMode: "fullscreen" };
  /**
   * A form the DO has already seen submitted opens read-only.
   *
   * Not freezing would let a stale tab — a link opened again tomorrow — quietly
   * overwrite a finished form's answers on the next keystroke. Revising a
   * submitted form is a real thing to want, but it should start from the agent
   * rendering it again, not from a page that outlived its purpose.
   */
  const frozen = bootstrap.submitted === true;
  let saveDraftFailures = 0;
  let saveDraftStopped = false;
  let completeFlush = false;
  let submittedFlush = false;
  let unsubscribeStore: (() => void) | null = null;

  const draftPush = debounce(async () => {
    if (frozen || saveDraftStopped || saveDraftFailures >= SAVE_DRAFT_GIVE_UP_AFTER) return;
    const state = store.getState();
    if (!state.form || state.status !== "ready") return;
    const complete = completeFlush;
    const submitted = submittedFlush;
    completeFlush = false;
    submittedFlush = false;
    // Identical to the host carrier: `complete` carries the WHOLE rendered
    // view because the Worker DELETES paths absent from a complete write, and
    // an incremental autosave that claimed completeness would delete every
    // path the user has not reached yet.
    const answers = complete ? (currentSubmission(store)?.answers ?? state.answers) : state.answers;
    let outcome: DraftOutcome;
    try {
      const response = await doFetch(bootstrap.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Same-origin only, and never with credentials: the signed URL is the
        // capability, so an ambient cookie would add reach without adding proof.
        credentials: "omit",
        body: JSON.stringify({
          formId: state.form.formId ?? bootstrap.formId,
          answers,
          ...(complete ? { complete: true } : {}),
          ...(submitted ? { submitted: true } : {}),
        }),
      });
      outcome = draftOutcome(await verdictOf(response));
    } catch {
      // Offline, or the tab has been open past the token's life.
      outcome = { kind: "failed" };
    }
    switch (outcome.kind) {
      case "throttled":
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
        // On this carrier a failed write is not the non-event it is inside a
        // host: there, `save_draft` may simply not exist yet and silence is
        // right. Here the endpoint is ours and the person is looking at the
        // page, so once we have stopped trying, say so.
        if (saveDraftFailures >= SAVE_DRAFT_GIVE_UP_AFTER) {
          store.getState().setDraftStatus(OFFLINE_NOTICE);
        }
        break;
      default:
        saveDraftFailures = 0;
        store.getState().setDraftStatus(submitted ? SUBMITTED_NOTICE : null);
        break;
    }
    emit({ type: "draft", ok: outcome.kind === "saved", outcome });
  }, options.saveDraftDebounceMs ?? SAVE_DRAFT_DEBOUNCE_MS);

  const flushComplete = async (flushOptions: { submitted?: boolean } = {}): Promise<void> => {
    completeFlush = true;
    if (flushOptions.submitted) submittedFlush = true;
    await draftPush.flush({
      force: flushOptions.submitted === true || store.getState().revision > 0,
    });
    // The flags are NOT cleared here. `draftPush` consumes them at the top of
    // every run, and a throttled write RE-ARMS them for its retry — clearing
    // them after the await would wipe exactly that, and the retry would go out
    // as a plain incremental draft. The DO's own contract says otherwise: the
    // first submit skips its rate limit, "later submits queue like anything
    // else, and the app preserves the flag across the retry". A second submit
    // (the user edited something and submitted again) is the case that breaks,
    // and it breaks silently — `submittedAt` never gets stamped, so the agent
    // reads a finished form as still in progress.
  };

  return {
    async start() {
      apply(hostContext);
      store.getState().setDisplayMode("fullscreen");
      // Touch is the honest signal here. There is no host to tell us what kind
      // of device this is, and §5.5's dense grid is what the answer gates.
      if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
        store.getState().setPlatform("mobile");
      }
      emit({ type: "context", context: hostContext });

      store.getState().loadForm(extractForm(bootstrap.form));
      if (bootstrap.answers && store.getState().status === "ready") {
        store.getState().hydrate(bootstrap.answers);
      }
      if (bootstrap.submitted) store.getState().setDraftStatus(SUBMITTED_NOTICE);

      let revision = store.getState().revision;
      unsubscribeStore = store.subscribe((state) => {
        if (state.revision === revision) return;
        revision = state.revision;
        if (frozen) return;
        draftPush.schedule();
      });
      return hostContext;
    },

    hostContext: () => hostContext,

    async submit() {
      const state = store.getState();
      const submission = currentSubmission(store);
      if (!submission || !state.form) return null;
      // The whole point of the carrier: this await is the only thing standing
      // between the person clicking submit and `get_answers` being able to
      // answer. There is no receipt to race.
      await flushComplete({ submitted: true });
      emit({ type: "submitted", submission });
      return submission;
    },

    /** The tab is the viewport (§7.3). Nothing to request, nothing to report. */
    async requestDisplayMode() {
      return "fullscreen";
    },

    reportSize() {},

    observe() {
      return () => {};
    },

    flush: flushComplete,

    formId: () => store.getState().form?.formId ?? bootstrap.formId,

    frozen: () => frozen,

    stop() {
      draftPush.cancel();
      unsubscribeStore?.();
    },
  };
}

export type { Submission };
