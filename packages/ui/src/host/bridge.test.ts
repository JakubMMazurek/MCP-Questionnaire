/**
 * The host bridge against the SDK's OWN host side (§7.2).
 *
 * Both ends now run `@modelcontextprotocol/ext-apps` — `App` here, `AppBridge`
 * in `fake-host.ts` — so these tests are checked against the extension's real
 * generated schemas rather than against a fake we wrote to match ourselves.
 * That distinction is the whole reason this file exists: the hand-rolled layer
 * this replaced sent `clientInfo` where `ui/initialize` requires `appInfo`, and
 * a single content block where `ui/message` requires an array, and a suite with
 * a hand-rolled host on the other end could never have caught either.
 *
 * What these tests pin down above the wire is the etiquette, because getting it
 * wrong is invisible until it is deployed: the handshake order, that mid-fill
 * pushes carry a summary and not the payload, that teardown answers only after
 * the final draft flush, and that a missing `save_draft` tool is a non-event.
 */

import type { Answers } from "@mcpq/schema";
import { assumptionLedger } from "@mcpq/schema";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineStore, type EngineStore } from "../engine/index.js";
import { createBridge, MODEL_CONTEXT_DEBOUNCE_MS, SAVE_DRAFT_DEBOUNCE_MS } from "./bridge.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { type HostContext, METHOD } from "./protocol.js";

/**
 * Lets every queued microtask run. The SDK's `Protocol` puts a few more promise
 * hops between a send and its response than the hand-rolled peer did, so this
 * is generous rather than exact — it costs nothing and removes a class of
 * flake.
 */
async function settle(times = 24): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
}

const VERDICT = "assumptions[r_eu][verdict]";

type ToolsCall = (params: CallToolRequest["params"]) => unknown | Error;

type Harness = {
  store: EngineStore;
  host: FakeHost;
  bridge: ReturnType<typeof createBridge>;
  applied: HostContext[];
};

async function connect(
  options: { hostContext?: HostContext; onToolsCall?: ToolsCall } = {},
): Promise<Harness> {
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
  const store = createEngineStore();
  const applied: HostContext[] = [];
  const host = createFakeHost({
    transport: hostTransport,
    ...(options.hostContext ? { hostContext: options.hostContext } : {}),
    ...(options.onToolsCall ? { onToolsCall: options.onToolsCall } : {}),
  });
  const bridge = createBridge({
    transport: appTransport,
    store,
    applyContext: (context) => applied.push(context),
  });
  await bridge.start();
  await settle();
  return { store, host, bridge, applied };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the handshake (§7.2)", () => {
  it("sends ui/initialize, then ui/notifications/initialized", async () => {
    const { host } = await connect();
    expect(host.seen.map((entry) => entry.method)).toEqual([METHOD.initialize, METHOD.initialized]);
  });

  it("declares the protocol version and the display modes it supports", async () => {
    const { host } = await connect();
    expect(host.seen[0]?.params).toMatchObject({
      protocolVersion: "2026-01-26",
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
  });

  /**
   * The regression that made the deployed app invisible in claude.ai. The
   * extension names this field `appInfo`; we sent `clientInfo`, our own fake
   * host did not care, and a host that validates rejects the connect — which
   * per the MCP Apps troubleshooting guide renders as nothing at all.
   */
  it("identifies itself as appInfo, never clientInfo", async () => {
    const { host } = await connect();
    const params = host.seen[0]?.params as Record<string, unknown>;
    expect(params.appInfo).toEqual({
      name: "mcp-questionnaire-renderer",
      version: "0.1.0",
    });
    expect(params).not.toHaveProperty("clientInfo");
  });

  it("consumes hostContext: variables, theme and display mode", async () => {
    const { applied, store } = await connect({
      hostContext: {
        theme: "dark",
        displayMode: "fullscreen",
        styles: { variables: { "--color-text-primary": "#fff" } },
        safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 },
      },
    });
    expect(applied[0]?.theme).toBe("dark");
    expect(applied[0]?.styles?.variables).toEqual({ "--color-text-primary": "#fff" });
    expect(store.getState().displayMode).toBe("fullscreen");
  });

  it("merges a host-context-changed patch instead of replacing it", async () => {
    const harness = await connect({
      hostContext: { theme: "light", styles: { variables: { "--color-text-primary": "#000" } } },
    });
    harness.host.sendContextChange({ theme: "dark" });
    await settle();
    const latest = harness.applied.at(-1);
    expect(latest?.theme).toBe("dark");
    expect(latest?.styles?.variables).toEqual({ "--color-text-primary": "#000" });
  });
});

describe("tool input (§7.2)", () => {
  it("validates the schema through @mcpq/schema and renders it", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().form?.title).toBe("Before I draft the rollout plan…");
  });

  it("accepts the envelope wrapped in a `form` property too", async () => {
    const { host, store } = await connect();
    host.sendToolInput({ form: assumptionLedger });
    await settle();
    expect(store.getState().status).toBe("ready");
  });

  it("replays a draft that arrived beside the schema", async () => {
    const { host, store } = await connect();
    host.sendToolInput({
      form: assumptionLedger,
      answers: { [VERDICT]: { state: "answered", value: "fix" } },
    });
    await settle();
    expect(store.getState().answers[VERDICT]).toEqual({ state: "answered", value: "fix" });
  });

  it("renders a plain failure state for a malformed schema, never garbage", async () => {
    const { host, store } = await connect();
    host.sendToolInput({ version: 1, title: "no sections" });
    await settle();
    expect(store.getState().status).toBe("invalid");
    expect(store.getState().form).toBeNull();
    expect(store.getState().diagnostics.length).toBeGreaterThan(0);
  });

  it("buffers a partial schema and renders it only once it parses", async () => {
    const { host, store } = await connect();
    host.sendPartial({ version: 1, title: "Before I draft" });
    await settle();
    expect(store.getState().status).toBe("loading");

    host.sendPartial(assumptionLedger);
    await settle();
    expect(store.getState().status).toBe("ready");
  });
});

describe("outbound pushes (§7.2 context discipline)", () => {
  it("debounces the model-context push and sends a summary, not the payload", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();

    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(MODEL_CONTEXT_DEBOUNCE_MS - 1);
    await settle();
    expect(host.of(METHOD.updateModelContext)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    const pushes = host.of(METHOD.updateModelContext);
    expect(pushes).toHaveLength(1);
    const params = pushes[0]?.params as {
      content: { text: string }[];
      structuredContent?: unknown;
    };
    expect(params.content[0]?.text).toContain("inferred values unreviewed");
    expect(params.structuredContent).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain("assumptions[r_eu]");
  });

  it("collapses a burst of edits into one push", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    for (const row of ["r_eu", "r_salesops", "r_cutover"]) {
      store.getState().setAnswer(`assumptions[${row}][verdict]`, "confirm");
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(MODEL_CONTEXT_DEBOUNCE_MS);
    await settle();
    expect(host.of(METHOD.updateModelContext)).toHaveLength(1);
  });

  it("autosaves through the app-visible save_draft tool", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();
    const call = host.last(METHOD.toolsCall);
    expect(call?.params).toMatchObject({ name: "save_draft" });
    const params = call?.params as { arguments: { answers: Record<string, unknown> } };
    expect(params.arguments.answers[VERDICT]).toEqual({ state: "answered", value: "fix" });
  });

  it("tolerates save_draft being absent, and stops asking after a few refusals", async () => {
    const { host, store } = await connect({
      onToolsCall: () => new Error("Tool save_draft not found"),
    });
    host.sendToolInput(assumptionLedger);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      store.getState().setAnswer(VERDICT, `attempt ${i}`);
      await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
      await settle();
    }
    expect(host.of(METHOD.toolsCall)).toHaveLength(3);
    expect(store.getState().status).toBe("ready");
  });

  it("reports size only inline (§7.3)", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setDisplayMode("inline");
    bridge.reportSize(600, 420);
    await settle();
    expect(host.of(METHOD.sizeChanged)).toHaveLength(1);

    store.getState().setDisplayMode("fullscreen");
    bridge.reportSize(600, 900);
    await settle();
    expect(host.of(METHOD.sizeChanged)).toHaveLength(1);
  });

  it("asks for fullscreen and records what the host granted", async () => {
    const { store, bridge } = await connect();
    const granted = await bridge.requestDisplayMode("fullscreen");
    await settle();
    expect(granted).toBe("fullscreen");
    expect(store.getState().displayMode).toBe("fullscreen");
  });
});

describe("submit (§5.6)", () => {
  it("sends the full structured payload once, then the turn-triggering message", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = bridge.submit();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    const submission = await promise;

    expect(submission?.summary.answered).toBe(5);
    const context = host.last(METHOD.updateModelContext)?.params as {
      structuredContent?: { answers: Record<string, unknown> };
    };
    expect(context.structuredContent?.answers[VERDICT]).toEqual({
      state: "answered",
      value: "fix",
    });

    const message = host.last(METHOD.message)?.params as {
      role: string;
      content: { type: string; text: string }[];
    };
    expect(message.role).toBe("user");
    // The message lands VISIBLY in the conversation, so it is a short receipt —
    // the widget already shows every answer and the structured payload
    // travelled on the context channel above, never as JSON in the chat.
    expect(message.content[0]?.text).toBe("Submitted “Before I draft the rollout plan…”.");
  });

  it("falls back to JSON in the message only when the context push fails", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");
    host.failNext(METHOD.updateModelContext);

    const promise = bridge.submit();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await promise;

    const message = host.last(METHOD.message)?.params as {
      content: { text: string }[];
    };
    // Last-resort carrier: the answers must never be lost outright.
    expect(message.content[0]?.text).toContain('"state":"answered"');
  });

  /**
   * `ui/message` params are `{ role, content: ContentBlock[] }`. The
   * hand-rolled layer sent ONE block, unwrapped — schema-invalid, so a strict
   * host drops the submit and the user's answers go nowhere.
   */
  it("sends ui/message content as an array of blocks", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = bridge.submit();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await promise;

    const message = host.last(METHOD.message)?.params as { content: unknown };
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content).toMatchObject([{ type: "text" }]);
  });

  it("flushes a pending draft before the payload goes out", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = bridge.submit();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await promise;
    const order = host.seen.map((entry) => entry.method);
    expect(order.indexOf(METHOD.toolsCall)).toBeLessThan(order.indexOf(METHOD.message));
  });
});

describe("the load_form round trip (§7.2, step 5 stage A)", () => {
  /** `get_form_state`'s real result shape (packages/worker/src/mcp-server.ts). */
  const formState = (answers: Answers = {}) => ({
    content: [{ type: "text", text: "form f_x: 1 section(s)" }],
    structuredContent: {
      form: { ...assumptionLedger, formId: "f_reopened" },
      answers,
      createdAt: 1,
      updatedAt: 2,
    },
  });

  it("pulls its own schema when the tool input carries only a formId", async () => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const { host, store } = await connect({
      onToolsCall: (params) => {
        const call = params as { name: string; arguments: Record<string, unknown> };
        calls.push(call);
        return call.name === "get_form_state" ? formState() : { structuredContent: { ok: true } };
      },
    });

    host.sendToolInput({ formId: "f_reopened" });
    await settle();

    expect(calls[0]).toMatchObject({ name: "get_form_state", arguments: { formId: "f_reopened" } });
    expect(store.getState().status).toBe("ready");
    expect(store.getState().form?.formId).toBe("f_reopened");
  });

  it("replays the answers that came back with it", async () => {
    const { host, store } = await connect({
      onToolsCall: (params) =>
        (params as { name: string }).name === "get_form_state"
          ? formState({ [VERDICT]: { state: "answered", value: "tbd" } })
          : { structuredContent: { ok: true } },
    });
    host.sendToolInput({ formId: "f_reopened" });
    await settle();
    expect(store.getState().answers[VERDICT]).toEqual({ state: "answered", value: "tbd" });
  });

  it("still renders a form that arrives whole, without asking the server", async () => {
    const calls: unknown[] = [];
    const { host, store } = await connect({
      onToolsCall: (params) => {
        calls.push(params);
        return { structuredContent: { ok: true } };
      },
    });
    // `gather_decisions` input carries the envelope AND (harmlessly) an id.
    host.sendToolInput({ formId: "f_x", form: assumptionLedger });
    await settle();
    expect(calls).toHaveLength(0);
    expect(store.getState().status).toBe("ready");
  });

  it("stays on the skeletons and says so when the pull fails", async () => {
    const { host, store } = await connect({
      onToolsCall: () => new Error("form f_gone not found — it may have expired"),
    });
    host.sendToolInput({ formId: "f_gone" });
    await settle();
    expect(store.getState().status).toBe("loading");
    expect(store.getState().draftStatus).toContain("could not be reopened");
  });
});

describe("learning the formId (§3, step 5 stage A)", () => {
  it("takes it from the tool-result stub, so save_draft stops sending null", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    host.sendToolResult({
      content: [{ type: "text", text: "Form displayed; awaiting input. formId: f_minted" }],
      structuredContent: { formId: "f_minted" },
    });
    await settle();

    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();

    const call = host.last(METHOD.toolsCall)?.params as { arguments: { formId: unknown } };
    expect(call.arguments.formId).toBe("f_minted");
  });

  it("accepts a host that wraps the result, and reports what it learned", async () => {
    const { host, bridge } = await connect();
    host.sendToolResult({ result: { structuredContent: { formId: "f_wrapped" } } });
    await settle();
    expect(bridge.formId()).toBe("f_wrapped");
  });

  it("sends null when nothing ever told it an id — a documented non-event", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();
    const call = host.last(METHOD.toolsCall)?.params as { arguments: { formId: unknown } };
    expect(call.arguments.formId).toBeNull();
  });
});

describe("draft throttle semantics (§3, step 5 stage A)", () => {
  /** The Worker's refusal shapes, verbatim from mcp-server.ts. */
  const throttled = {
    content: [{ type: "text", text: "draft not saved — too many writes" }],
    structuredContent: { ok: false, code: "throttled", retryAfterMs: 900 },
    isError: true,
  };
  const tooLarge = {
    content: [{ type: "text", text: "draft not saved — too big" }],
    structuredContent: {
      ok: false,
      code: "too_large",
      bytes: 300_000,
      limit: 262_144,
    },
    isError: true,
  };

  it("backs off by retryAfterMs and retries, without counting a failure", async () => {
    let refusals = 0;
    const { host, store } = await connect({
      onToolsCall: () => {
        refusals += 1;
        return refusals <= 4 ? throttled : { structuredContent: { ok: true, saved: 1 } };
      },
    });
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();
    expect(host.of(METHOD.toolsCall)).toHaveLength(1);

    // Nothing before the interval the DO asked for, one call after it.
    await vi.advanceTimersByTimeAsync(899);
    await settle();
    expect(host.of(METHOD.toolsCall)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(host.of(METHOD.toolsCall)).toHaveLength(2);

    // Four throttles is past SAVE_DRAFT_GIVE_UP_AFTER: a plain rejection would
    // have stopped asking by now. A throttle is not a failure, so it keeps going
    // and eventually saves.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(900);
      await settle();
    }
    expect(host.of(METHOD.toolsCall).length).toBeGreaterThanOrEqual(5);
    expect(store.getState().draftStatus).toBeNull();
  });

  it("stops retrying an oversized draft and surfaces it in the status line", async () => {
    const { host, store } = await connect({ onToolsCall: () => tooLarge });
    host.sendToolInput(assumptionLedger);
    await settle();

    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();
    expect(host.of(METHOD.toolsCall)).toHaveLength(1);
    expect(store.getState().draftStatus).toContain("Too much to autosave");
    expect(store.getState().draftStatus).toContain("293 kB");

    for (let i = 0; i < 3; i += 1) {
      store.getState().setAnswer(VERDICT, `attempt ${i}`);
      await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS * 2);
      await settle();
    }
    expect(host.of(METHOD.toolsCall)).toHaveLength(1);
  });

  it("treats formId: null as a non-event, not a failure", async () => {
    const noStore = {
      content: [{ type: "text", text: "no formId" }],
      structuredContent: { ok: false, code: "no_form_id" },
    };
    const { host, store } = await connect({ onToolsCall: () => noStore });
    host.sendToolInput(assumptionLedger);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      store.getState().setAnswer(VERDICT, `attempt ${i}`);
      await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
      await settle();
    }
    expect(host.of(METHOD.toolsCall)).toHaveLength(5);
    expect(store.getState().draftStatus).toBeNull();
  });
});

describe("complete drafts (§3, step 5 stage A)", () => {
  it("marks the submit flush complete, and sends the whole rendered view", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = bridge.submit();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await promise;

    const call = host.last(METHOD.toolsCall)?.params as {
      arguments: { complete?: boolean; answers: Record<string, unknown> };
    };
    expect(call.arguments.complete).toBe(true);
    // Every leaf, not just the touched one: on a complete write the DO deletes
    // paths absent from the payload.
    expect(Object.keys(call.arguments.answers).length).toBe(10);
  });

  it("marks the teardown flush complete too", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = host.teardown();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await promise;

    const call = host.last(METHOD.toolsCall)?.params as { arguments: { complete?: boolean } };
    expect(call.arguments.complete).toBe(true);
  });

  it("leaves incremental autosaves incremental", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");
    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
    await settle();

    const call = host.last(METHOD.toolsCall)?.params as {
      arguments: { complete?: boolean; answers: Record<string, unknown> };
    };
    expect(call.arguments.complete).toBeUndefined();
    expect(Object.keys(call.arguments.answers)).toEqual([VERDICT]);
  });

  it("does not spend a round trip flushing an untouched form", async () => {
    const { host, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    await bridge.flush();
    await settle();
    expect(host.of(METHOD.toolsCall)).toHaveLength(0);
  });
});

describe("cancellation and teardown (§7.2)", () => {
  it("freezes the form and stops pushing on tool-cancelled", async () => {
    const { host, store, bridge } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");
    host.sendCancelled("user hit stop");
    await settle();

    await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS * 2);
    await settle();
    expect(store.getState().status).toBe("cancelled");
    expect(bridge.frozen()).toBe(true);
    expect(host.of(METHOD.updateModelContext)).toHaveLength(0);
    expect(host.of(METHOD.toolsCall)).toHaveLength(0);
  });

  it("answers ui/resource-teardown only after the final save_draft", async () => {
    const { host, store } = await connect();
    host.sendToolInput(assumptionLedger);
    await settle();
    store.getState().setAnswer(VERDICT, "fix");

    const promise = host.teardown();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    const seenWhenAnswered = await promise;
    expect(seenWhenAnswered.some((entry) => entry.method === METHOD.toolsCall)).toBe(true);
  });
});
