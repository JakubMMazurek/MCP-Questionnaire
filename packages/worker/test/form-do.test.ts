/**
 * The form Durable Object, driven directly (§3 "Document mode").
 *
 * The tool tests above cover the same code through MCP; these cover what MCP
 * cannot reach: the row-level write semantics, the `complete` flag, and the
 * 30-day TTL alarm actually wiping the object.
 *
 * `runDurableObjectAlarm` is the pool's own way to advance to an alarm —
 * Vitest's fake timers do not drive the storage simulators (a documented known
 * issue), so the alarm is invoked through the platform helper rather than by
 * moving a clock.
 */

import {
  env,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { assumptionLedger } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import type { FormDO, FormStore } from "../src/form-do.js";
import { IDLE_TTL_MS, MIN_DRAFT_INTERVAL_MS } from "../src/form-do.js";
import { mintFormId } from "../src/form-id.js";

function store(formId: string) {
  const stub = env.FORM_DO.getByName(formId);
  return { stub, rpc: stub as unknown as FormStore };
}

const form = (formId: string) =>
  ({ ...structuredClone(assumptionLedger), formId }) as unknown as Parameters<FormStore["init"]>[0];

async function seeded() {
  const formId = mintFormId();
  const { stub, rpc } = store(formId);
  await rpc.init(form(formId));
  return { formId, stub, rpc };
}

describe("init / getState", () => {
  it("stores the stamped envelope and hands it back", async () => {
    const { formId, rpc } = await seeded();
    const state = await rpc.getState();
    expect(state?.form.formId).toBe(formId);
    expect(state?.form.title).toBe(assumptionLedger.title);
    expect(state?.answers).toEqual({});
  });

  it("returns null for an id that was never initialised", async () => {
    const { rpc } = store(mintFormId());
    expect(await rpc.getState()).toBeNull();
    expect(await rpc.exists()).toBe(false);
  });

  it("keeps createdAt and keeps answers across a re-init", async () => {
    const { rpc } = await seeded();
    const before = await rpc.getState();
    await rpc.saveDraft({
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "fix" } },
    });
    await rpc.init({ ...form("x"), title: "Renamed" });
    const after = await rpc.getState();

    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.form.title).toBe("Renamed");
    // Forms are documents (§10): a re-render must not silently discard answers.
    expect(after?.answers["assumptions[r_eu].verdict"]).toEqual({
      state: "answered",
      value: "fix",
    });
  });
});

describe("saveDraft — answers as rows (§3)", () => {
  it("upserts only the paths in the payload", async () => {
    const { stub, rpc } = await seeded();
    await rpc.saveDraft({
      answers: {
        "assumptions[r_eu].verdict": { state: "answered", value: "confirm" },
        "assumptions[r_cutover].verdict": { state: "answered", value: "tbd" },
      },
    });
    // The throttle is real, so step past it before the second write.
    await bypassThrottle(stub);
    await rpc.saveDraft({
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "fix" } },
    });

    const state = await rpc.getState();
    expect(state?.answers).toEqual({
      "assumptions[r_eu].verdict": { state: "answered", value: "fix" },
      "assumptions[r_cutover].verdict": { state: "answered", value: "tbd" },
    });
  });

  it("round-trips every answer shape, notes and non-string values included", async () => {
    const { rpc } = await seeded();
    const answers = {
      "a.string": { state: "answered", value: "text" },
      "a.number": { state: "answered", value: 42 },
      "a.boolean": { state: "answered", value: false },
      "a.array": { state: "answered", value: ["x", "y"] },
      "a.null": { state: "answered", value: null },
      "a.noted": { state: "answered", value: "v", note: "why" },
      "a.empty": { state: "empty" },
      "a.emptyNoted": { state: "empty", note: "come back to this" },
    } as const;
    await rpc.saveDraft({ answers: answers as never });
    expect((await rpc.getState())?.answers).toEqual(answers);
  });

  it("deletes absent paths only when the payload says it is complete", async () => {
    const { stub, rpc } = await seeded();
    await rpc.saveDraft({
      answers: {
        "assumptions[r_eu].verdict": { state: "answered", value: "confirm" },
        "assumptions[r_gone].verdict": { state: "answered", value: "confirm" },
      },
    });

    await bypassThrottle(stub);
    const incremental = await rpc.saveDraft({
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "fix" } },
    });
    expect(incremental).toMatchObject({ ok: true, deleted: 0 });
    expect(Object.keys((await rpc.getState())?.answers ?? {})).toHaveLength(2);

    await bypassThrottle(stub);
    const complete = await rpc.saveDraft({
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "fix" } },
      complete: true,
    });
    expect(complete).toMatchObject({ ok: true, deleted: 1 });
    expect(Object.keys((await rpc.getState())?.answers ?? {})).toEqual([
      "assumptions[r_eu].verdict",
    ]);
  });

  it("refuses to write against an id with no form", async () => {
    const { rpc } = store(mintFormId());
    expect(await rpc.saveDraft({ answers: {} })).toMatchObject({ ok: false, code: "no_form" });
  });

  it("throttles per form, and the interval is per-form state, not per-isolate", async () => {
    const a = await seeded();
    const b = await seeded();
    const answers = { "x.y": { state: "answered", value: 1 } } as never;

    expect(await a.rpc.saveDraft({ answers })).toMatchObject({ ok: true });
    expect(await a.rpc.saveDraft({ answers })).toMatchObject({ code: "throttled" });
    // A different form is a different DO, so it is not throttled by a's write.
    expect(await b.rpc.saveDraft({ answers })).toMatchObject({ ok: true });
  });
});

describe("the 30-day idle TTL (§3)", () => {
  it("arms the alarm on init", async () => {
    const { stub } = await seeded();
    const armed = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(armed).toBeGreaterThan(Date.now() + IDLE_TTL_MS - 60_000);
  });

  it("re-arms on a READ, not just a write", async () => {
    const { stub, rpc } = await seeded();
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now() + 5_000));
    await rpc.getState();
    const armed = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(armed).toBeGreaterThan(Date.now() + IDLE_TTL_MS - 60_000);
  });

  it("wipes the form when it fires — one deleteAll(), alarm included", async () => {
    const { formId, stub, rpc } = await seeded();
    await rpc.saveDraft({
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "confirm" } },
    });
    expect(await rpc.exists()).toBe(true);

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Everything is gone: the schema, the answer rows, and the alarm itself
    // (compatibility_date ≥ 2026-02-24 — deleteAll() clears it).
    expect(await rpc.getState()).toBeNull();
    expect(await rpc.exists()).toBe(false);
    const armed = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(armed).toBeNull();

    // And an expired id is exactly an unknown id from the outside.
    expect(await listDurableObjectIds(env.FORM_DO)).toBeInstanceOf(Array);
    expect(formId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("an expired form takes no further writes", async () => {
    const { stub, rpc } = await seeded();
    await runDurableObjectAlarm(stub);
    expect(await rpc.saveDraft({ answers: {} })).toMatchObject({ ok: false, code: "no_form" });
  });
});

/**
 * §10 "Audit attribution", un-parked by build step 7: an identity now exists,
 * so writes record one. Latest writer only — a full history is a different
 * feature with a different storage shape, and v1 does not need it.
 */
describe("attribution (§10)", () => {
  it("is null when nothing authenticated the write", async () => {
    const { rpc } = await seeded();
    expect((await rpc.getState())?.updatedBy).toBeNull();
  });

  it("records the login that created the form", async () => {
    const formId = mintFormId();
    const { rpc } = store(formId);
    await rpc.init(form(formId), "octocat");
    expect((await rpc.getState())?.updatedBy).toBe("octocat");
  });

  it("moves to the latest writer on saveDraft", async () => {
    const formId = mintFormId();
    const { stub, rpc } = store(formId);
    await rpc.init(form(formId), "octocat");
    await bypassThrottle(stub);
    await rpc.saveDraft({ answers: {}, updatedBy: "hubot" });
    expect((await rpc.getState())?.updatedBy).toBe("hubot");
  });

  it("an unattributed write LEAVES the last known writer, it does not blank it", async () => {
    const formId = mintFormId();
    const { stub, rpc } = store(formId);
    await rpc.init(form(formId), "octocat");
    await bypassThrottle(stub);
    await rpc.saveDraft({ answers: {} });
    expect((await rpc.getState())?.updatedBy).toBe("octocat");
    // Same rule on re-init.
    await rpc.init(form(formId));
    expect((await rpc.getState())?.updatedBy).toBe("octocat");
  });

  it("adds the column to a form table created before build step 7", async () => {
    const { stub, rpc } = await seeded();
    // Reproduce the pre-step-7 shape: the column simply is not there.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE form DROP COLUMN updatedBy");
    });
    // Every read names `updatedBy`, so without the migration this throws.
    expect((await rpc.getState())?.updatedBy).toBeNull();
    await bypassThrottle(stub);
    await rpc.saveDraft({ answers: {}, updatedBy: "octocat" });
    expect((await rpc.getState())?.updatedBy).toBe("octocat");
  });
});

/**
 * Steps the form's throttle clock back so the next write is allowed.
 *
 * The alternative is a real `sleep(1000)` per assertion. The throttle itself is
 * covered directly above; here it is scaffolding in the way of the semantics
 * being tested.
 */
async function bypassThrottle(stub: DurableObjectStub<FormDO>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE form SET lastDraftAt = ? WHERE id = 1",
      Date.now() - MIN_DRAFT_INTERVAL_MS * 2,
    );
  });
}
