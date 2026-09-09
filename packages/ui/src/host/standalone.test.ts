/**
 * The standalone carrier, against a fake origin.
 *
 * `bridge.test.ts` proves the etiquette above the postMessage wire. This file
 * proves the same etiquette survives the change of wire, because that is the
 * whole claim of the standalone route: the DESTINATION of a draft is the same
 * Durable Object, the SHAPE of a submit is the same whole rendered view, and
 * the verdicts — throttled, too large, gone — still mean what they meant.
 *
 * What it deliberately does not re-test is anything the engine owns. If a
 * change here required touching a schema or engine test, the seam was drawn in
 * the wrong place.
 */

import type { Answers } from "@mcpq/schema";
import { assumptionLedger } from "@mcpq/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineStore, type EngineStore } from "../engine/index.js";
import { SAVE_DRAFT_DEBOUNCE_MS, SAVE_DRAFT_GIVE_UP_AFTER } from "./bridge.js";
import {
  createStandaloneBridge,
  OFFLINE_NOTICE,
  type StandaloneBootstrap,
  SUBMITTED_NOTICE,
} from "./standalone.js";

const VERDICT = "assumptions[r_eu][verdict]";
const ENDPOINT = "https://forms.example/f/tok_abc";

type Posted = {
  formId: string | null;
  answers: Answers;
  complete?: boolean;
  submitted?: boolean;
};

type Reply = { status?: number; body?: Record<string, unknown> };

type Harness = {
  store: EngineStore;
  bridge: ReturnType<typeof createStandaloneBridge>;
  posts: Posted[];
  /** Set to change what the next POST gets back. */
  reply: (next: Reply) => void;
};

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function mount(
  options: { bootstrap?: Partial<StandaloneBootstrap>; reply?: Reply } = {},
): Promise<Harness> {
  const posts: Posted[] = [];
  let next: Reply = options.reply ?? { body: { ok: true } };
  const store = createEngineStore();
  const bridge = createStandaloneBridge({
    store,
    applyContext: () => {},
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)) as Posted);
      return new Response(JSON.stringify(next.body ?? { ok: true }), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    bootstrap: {
      form: assumptionLedger,
      formId: "f_test",
      endpoint: ENDPOINT,
      ...options.bootstrap,
    },
  });
  await bridge.start();
  await settle();
  return { store, bridge, posts, reply: (value) => (next = value) };
}

/** Types an answer and lets the debounce fire. */
async function answer(harness: Harness, value: string): Promise<void> {
  harness.store.getState().setAnswer(VERDICT, value);
  await vi.advanceTimersByTimeAsync(SAVE_DRAFT_DEBOUNCE_MS);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("start", () => {
  it("renders the inlined schema with no round trip", async () => {
    const { store, posts } = await mount();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().form?.title).toBe(assumptionLedger.title);
    // The page arrived holding the form. Nothing was asked of the network.
    expect(posts).toHaveLength(0);
  });

  it("hydrates a reopened draft", async () => {
    const { store } = await mount({
      bootstrap: { answers: { [VERDICT]: "fix" } as unknown as Answers },
    });
    expect(store.getState().answers[VERDICT]).toBe("fix");
  });

  /** A tab has one display mode, and the app must not negotiate for another. */
  it("is fullscreen, and says so once", async () => {
    const { store, bridge } = await mount();
    expect(store.getState().displayMode).toBe("fullscreen");
    await expect(bridge.requestDisplayMode("inline")).resolves.toBe("fullscreen");
  });

  it("renders a form the DO has already seen submitted, and stops writing", async () => {
    const harness = await mount({ bootstrap: { submitted: true } });
    expect(harness.store.getState().draftStatus).toBe(SUBMITTED_NOTICE);
    await answer(harness, "fix");
    expect(harness.posts).toHaveLength(0);
  });
});

describe("drafts", () => {
  it("autosaves an incremental view that never claims to be complete", async () => {
    const harness = await mount();
    await answer(harness, "fix");
    expect(harness.posts).toHaveLength(1);
    const post = harness.posts[0];
    expect(post?.formId).toBe("f_test");
    expect(post?.complete).toBeUndefined();
    expect(post?.submitted).toBeUndefined();
  });

  /**
   * The §3 rule that a mid-fill save must not delete what the user has not
   * reached: only a complete write carries the whole view, and the Worker
   * deletes by absence on exactly those.
   */
  it("sends the whole rendered view on submit, once, marked submitted", async () => {
    const harness = await mount();
    await answer(harness, "fix");
    harness.posts.length = 0;
    await harness.bridge.submit();
    await settle();
    expect(harness.posts).toHaveLength(1);
    const post = harness.posts[0];
    expect(post?.complete).toBe(true);
    expect(post?.submitted).toBe(true);
    // Every leaf, hidden ones included as `empty` — not just what was touched.
    expect(Object.keys(post?.answers ?? {}).length).toBeGreaterThan(1);
  });

  it("does not mark a teardown flush submitted", async () => {
    const harness = await mount();
    await answer(harness, "fix");
    harness.posts.length = 0;
    await harness.bridge.flush();
    await settle();
    expect(harness.posts[0]?.complete).toBe(true);
    expect(harness.posts[0]?.submitted).toBeUndefined();
  });

  /** A submit on an untouched form is a real answer (§5.4), so it is forced. */
  it("submits a form nobody typed into", async () => {
    const harness = await mount();
    await harness.bridge.submit();
    await settle();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]?.submitted).toBe(true);
  });

  it("says so on the status line once the answers are stored", async () => {
    const harness = await mount();
    await harness.bridge.submit();
    await settle();
    expect(harness.store.getState().draftStatus).toBe(SUBMITTED_NOTICE);
  });
});

describe("verdicts", () => {
  /**
   * Throttling is a refusal of PACE, not of content: back off by exactly what
   * was asked, keep the flags, and do not count it as a failure — a fast typist
   * would otherwise trip the give-up counter.
   */
  it("backs off by what the store asked for, and keeps the submit flags", async () => {
    const harness = await mount();
    harness.reply({ status: 429, body: { ok: false, code: "throttled", retryAfterMs: 900 } });
    await harness.bridge.submit();
    await settle();
    expect(harness.posts).toHaveLength(1);

    harness.reply({ body: { ok: true } });
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    expect(harness.posts).toHaveLength(2);
    // The retry still carries what the first attempt was for.
    expect(harness.posts[1]?.complete).toBe(true);
    expect(harness.posts[1]?.submitted).toBe(true);
  });

  it("stops after a refusal that retrying cannot fix, and says why", async () => {
    const harness = await mount();
    harness.reply({
      status: 413,
      body: { ok: false, code: "too_large", bytes: 400_000, limit: 262_144 },
    });
    await answer(harness, "fix");
    expect(harness.store.getState().draftStatus).toMatch(/Too much to autosave/);

    harness.posts.length = 0;
    await answer(harness, "tbd");
    // Retrying an oversized payload cannot help, so it does not.
    expect(harness.posts).toHaveLength(0);
  });

  it("gives up after repeated failures and tells the person their answers are still on screen", async () => {
    const harness = await mount();
    harness.reply({ status: 500, body: { ok: false, code: "internal" } });
    for (let i = 0; i < SAVE_DRAFT_GIVE_UP_AFTER; i += 1) {
      await answer(harness, `fix-${i}`);
    }
    expect(harness.store.getState().draftStatus).toBe(OFFLINE_NOTICE);

    harness.posts.length = 0;
    await answer(harness, "again");
    expect(harness.posts).toHaveLength(0);
  });

  /** An HTML error page from in front of the Worker is a failure, not a crash. */
  it("survives a response that is not JSON", async () => {
    const harness = await mount();
    harness.reply({ status: 502, body: undefined });
    const bridge = createStandaloneBridge({
      store: harness.store,
      applyContext: () => {},
      fetchImpl: (async () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
      bootstrap: { form: assumptionLedger, formId: "f_test", endpoint: ENDPOINT },
    });
    await bridge.start();
    await expect(bridge.submit()).resolves.not.toBeNull();
  });
});
