/**
 * The host bridge against a faked host over the same transport (§7.2).
 *
 * What these tests pin down is the etiquette, because getting it wrong is
 * invisible until it is deployed: the handshake order, that mid-fill pushes
 * carry a summary and not the payload, that teardown answers only after the
 * final draft flush, and that a missing `save_draft` tool is a non-event.
 */

import { assumptionLedger } from "@gather/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineStore, type EngineStore } from "../engine/index.js";
import { createBridge, MODEL_CONTEXT_DEBOUNCE_MS, SAVE_DRAFT_DEBOUNCE_MS } from "./bridge.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { type HostContext, METHOD } from "./protocol.js";
import { memoryPair } from "./transport.js";

/** Lets every queued microtask (the memory transport's delivery) run. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
}

const VERDICT = "assumptions[r_eu][verdict]";

type Harness = {
  store: EngineStore;
  host: FakeHost;
  bridge: ReturnType<typeof createBridge>;
  applied: HostContext[];
};

async function connect(
  options: { hostContext?: HostContext; onToolsCall?: (params: unknown) => unknown | Error } = {},
): Promise<Harness> {
  const pair = memoryPair();
  const store = createEngineStore();
  const applied: HostContext[] = [];
  const host = createFakeHost({
    transport: pair.host,
    ...(options.hostContext ? { hostContext: options.hostContext } : {}),
    ...(options.onToolsCall ? { onToolsCall: options.onToolsCall } : {}),
  });
  const bridge = createBridge({
    transport: pair.app,
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
  it("validates the schema through @gather/schema and renders it", async () => {
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
      content: { type: string; text: string };
    };
    expect(message.role).toBe("user");
    expect(message.content.text).toContain('"state":"answered"');
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
