/**
 * The tool surface end to end (§3, §7.1): declaration, the stub contract, the
 * autosave round trip, and the two hardening limits.
 */

import { assumptionLedger } from "@mcpq/schema";
import { describe, expect, it } from "vitest";
import { MAX_DRAFT_BYTES } from "../src/form-do.js";
import { FORM_ID_PATTERN } from "../src/form-id.js";
import { RENDERER_MIME_TYPE, RENDERER_URI } from "../src/renderer-resource.js";
import { connect, firstText } from "./harness.js";

const ledger = () => structuredClone(assumptionLedger) as unknown as Record<string, unknown>;

async function mintForm(): Promise<{ formId: string; text: string }> {
  const { call, close } = await connect();
  const result = await call("gather_decisions", { form: ledger() });
  await close();
  const text = firstText(result);
  const formId = (result.structuredContent as { formId?: string } | undefined)?.formId ?? "";
  return { formId, text };
}

/* -------------------------------------------------------------------------- */

describe("declaration (§7.1)", () => {
  it("declares _meta.ui in the nested form, with the right visibility per tool", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    await close();

    const meta = (name: string) =>
      (tools.find((t) => t.name === name)?._meta as { ui?: Record<string, unknown> } | undefined)
        ?.ui;

    for (const name of ["gather_decisions", "get_form_guide", "load_form"]) {
      expect(meta(name), name).toEqual({
        resourceUri: RENDERER_URI,
        visibility: ["model", "app"],
      });
    }
    // §7.1 — anything the UI needs and the model must not see.
    for (const name of ["save_draft", "get_form_state"]) {
      expect(meta(name), name).toEqual({ visibility: ["app"] });
    }
  });

  it("keeps gather_decisions' inputSchema loose (§6.3)", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    await close();
    const schema = tools.find((t) => t.name === "gather_decisions")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    // One free-form `form` object, not a recursive rendering of the meta-schema.
    expect(Object.keys(schema.properties ?? {})).toEqual(["form"]);
    expect(JSON.stringify(schema)).not.toContain("single_select");
  });

  it("carries the §6.1 trigger and the don'ts in the description", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    await close();
    const description = tools.find((t) => t.name === "gather_decisions")?.description ?? "";
    expect(description).toContain("about to write clarifying questions as prose bullets");
    expect(description).toContain("just ask it");
    expect(description).toContain('"A or B?"');
    expect(description).toContain("already gave detailed constraints");
    expect(description).toContain("Venting");
    expect(description).toContain("get_form_guide");
  });
});

describe("the renderer resource", () => {
  it("is listed, with prefersBorder", async () => {
    const { client, close } = await connect();
    const { resources } = await client.listResources();
    await close();
    const resource = resources.find((r) => r.uri === RENDERER_URI);
    expect(resource?.mimeType).toBe(RENDERER_MIME_TYPE);
    expect(resource?._meta).toEqual({ ui: { prefersBorder: true } });
  });

  it("reads back the built bundle, with _meta on the CONTENT item", async () => {
    const { client, close } = await connect();
    const read = await client.readResource({ uri: RENDERER_URI });
    await close();
    const item = read.contents[0] as { mimeType?: string; text?: string; _meta?: unknown };
    expect(item.mimeType).toBe(RENDERER_MIME_TYPE);
    // §7.1 — the content item's _meta is the one that governs.
    expect(item._meta).toEqual({ ui: { prefersBorder: true } });
    // It is the real single-file bundle, not a placeholder.
    expect(item.text ?? "").toContain("<!doctype html>");
    expect((item.text ?? "").length).toBeGreaterThan(100_000);
    // Self-contained: nothing to fetch under `connect-src 'none'` (§3, §8).
    expect(item.text ?? "").not.toMatch(/<script[^>]+\bsrc=/i);
  });
});

describe("gather_decisions on a valid form", () => {
  it("mints a 32-hex formId and returns the stub — never the schema", async () => {
    const { formId, text } = await mintForm();
    expect(formId).toMatch(FORM_ID_PATTERN);
    expect(text).toContain(`Form displayed; awaiting input. formId: ${formId}`);

    // The whole point of §3's stub: none of the author's content comes back.
    for (const fragment of [
      assumptionLedger.title,
      assumptionLedger.sections[0]?.title,
      "Rollout targets the EU org only",
      "count_needs_review",
      "segmented",
      "sections",
      "prefill",
    ]) {
      expect(text, String(fragment)).not.toContain(String(fragment));
    }
    // And it is short. §7.5's 150k spill threshold is not something we approach.
    expect(text.length).toBeLessThan(200);
  });

  it("returns the bare stub when there is nothing to warn about", async () => {
    const { formId, text } = await mintForm();
    expect(text).toBe(`Form displayed; awaiting input. formId: ${formId}`);
  });

  it("reports warnings as CODES, never as the prose that quotes the schema", async () => {
    const { call, close } = await connect();
    const result = await call("gather_decisions", {
      form: {
        version: 1,
        title: "T",
        sections: [
          { id: "lonely", title: "S", fields: [{ type: "boolean", id: "b", label: "B" }] },
        ],
      },
    });
    await close();
    const body = firstText(result);
    expect(result.isError).toBeFalsy();
    // The closed part travels: count and codes.
    expect(body).toContain("2 warning(s): no_prefill, section_single_field");
    // The prose does not — it quotes the author's own ids and labels.
    expect(body).not.toContain("lonely");
    expect(body).not.toContain("§4.8");
    expect(body.length).toBeLessThan(300);
  });

  it("mints a fresh id every call", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await mintForm()).formId);
    expect(ids.size).toBe(5);
  });
});

describe("load_form", () => {
  it("teaches on an unknown or expired id", async () => {
    const { call, close } = await connect();
    const missing = await call("load_form", { formId: "0".repeat(32) });
    const malformed = await call("load_form", { formId: "fls-review" });
    await close();

    for (const result of [missing, malformed]) {
      expect(result.isError).toBe(true);
      const body = firstText(result);
      expect(body).toContain("not found");
      expect(body).toContain("30-day idle TTL");
      expect(body).toContain("gather_decisions");
    }
  });

  it("returns the same stub shape as gather_decisions, still without the schema", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();
    const result = await call("load_form", { formId });
    await close();
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe(`Form displayed; awaiting input. formId: ${formId}`);
    expect(result.structuredContent).toEqual({ formId });
  });
});

describe("save_draft + get_form_state", () => {
  it("round-trips through the Durable Object", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();

    const saved = await call("save_draft", {
      formId,
      answers: {
        "assumptions[r_eu].verdict": { state: "answered", value: "fix" },
        "assumptions[r_eu].correction": {
          state: "answered",
          value: "EU and UK",
          note: "UK is a separate org",
        },
        "assumptions[r_cutover].verdict": { state: "empty" },
      },
    });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({ ok: true, saved: 3 });

    const state = await call("get_form_state", { formId });
    await close();

    const structured = state.structuredContent as {
      form?: { formId?: string; title?: string };
      answers?: Record<string, unknown>;
    };
    // The shape the ui bridge's tool-input handler already accepts: the
    // envelope under `form`, an `answers` map beside it.
    expect(structured.form?.formId).toBe(formId);
    expect(structured.form?.title).toBe(assumptionLedger.title);
    expect(structured.answers).toEqual({
      "assumptions[r_eu].verdict": { state: "answered", value: "fix" },
      "assumptions[r_eu].correction": {
        state: "answered",
        value: "EU and UK",
        note: "UK is a separate org",
      },
      "assumptions[r_cutover].verdict": { state: "empty" },
    });
    // The payload travels in structuredContent only, never duplicated as text.
    expect(firstText(state)).not.toContain("EU and UK");
  });

  it("accepts formId: null gracefully instead of erroring", async () => {
    const { call, close } = await connect();
    const result = await call("save_draft", {
      formId: null,
      answers: { "a.b": { state: "answered", value: 1 } },
    });
    await close();
    // Not an error: the renderer's give-up counter must not trip on a fresh
    // gather_decisions render, where the app has no server-minted id yet.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: false, code: "no_form_id" });
    expect(firstText(result)).toContain("no formId");
  });

  it("rejects a malformed answer map with the validator's own words", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();
    const result = await call("save_draft", {
      formId,
      answers: { "a.b": { state: "maybe", value: 1 } },
    });
    await close();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "malformed_answers" });
  });

  it("rejects a payload over the 256 KiB cap", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();
    const answers: Record<string, unknown> = {};
    const filler = "x".repeat(1024);
    for (let i = 0; i < 300; i++) {
      answers[`assumptions[r_eu].note_${i}`] = { state: "answered", value: filler };
    }
    const result = await call("save_draft", { formId, answers });
    await close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "too_large",
      limit: MAX_DRAFT_BYTES,
    });
    expect(firstText(result)).toContain("256 KiB");
    expect(firstText(result)).toContain("Nothing was saved");
  });

  it("throttles a second write inside the minimum interval", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();
    const answers = { "assumptions[r_eu].verdict": { state: "answered", value: "confirm" } };

    const first = await call("save_draft", { formId, answers });
    const second = await call("save_draft", { formId, answers });
    await close();

    expect(first.structuredContent).toMatchObject({ ok: true });
    expect(second.isError).toBe(true);
    const structured = second.structuredContent as { code?: string; retryAfterMs?: number };
    expect(structured.code).toBe("throttled");
    expect(structured.retryAfterMs).toBeGreaterThan(0);
    expect(firstText(second)).toContain("retry in");
  });

  it("throttling does not lose the first write", async () => {
    const { formId } = await mintForm();
    const { call, close } = await connect();
    const answers = { "assumptions[r_eu].verdict": { state: "answered", value: "confirm" } };
    await call("save_draft", { formId, answers });
    await call("save_draft", {
      formId,
      answers: { "assumptions[r_eu].verdict": { state: "answered", value: "tbd" } },
    });
    const state = await call("get_form_state", { formId });
    await close();
    const stored = (state.structuredContent as { answers?: Record<string, unknown> }).answers;
    expect(stored).toEqual(answers);
  });
});

describe("get_form_guide", () => {
  it("returns a recipe plus worked examples for every archetype", async () => {
    const { call, close } = await connect();
    for (const archetype of [
      "ledger",
      "elicitation",
      "convergence",
      "plan_confirmation",
      "matrix",
    ]) {
      const result = await call("get_form_guide", { archetype });
      const body = firstText(result);
      expect(result.isError, archetype).toBeFalsy();
      expect(body, archetype).toContain("WORKED EXAMPLE");
      expect(body, archetype).toContain("ALWAYS, IN EVERY ARCHETYPE");
      // §5.6 mechanics, in every recipe.
      expect(body, archetype).toContain("Never ship a blank form");
      expect(body, archetype).toContain("Partial submit is the norm");
      expect(body, archetype).toContain("escape hatch");
      expect(body, archetype).toContain('{"version"');
    }
    await close();
  });

  it("ships two worked examples for the ledger", async () => {
    const { call, close } = await connect();
    const body = firstText(await call("get_form_guide", { archetype: "ledger" }));
    await close();
    expect(body).toContain("WORKED EXAMPLES");
    expect(body).toContain("the audited reference");
    expect(body).toContain("Assumption ledger — minimal");
  });

  it("carries the audited notes, which are what an author gets wrong", async () => {
    const { call, close } = await connect();
    const ledgerGuide = firstText(await call("get_form_guide", { archetype: "ledger" }));
    const convergenceGuide = firstText(await call("get_form_guide", { archetype: "convergence" }));
    const matrixGuide = firstText(await call("get_form_guide", { archetype: "matrix" }));
    await close();

    // §5.1 audit: provenance lives in the prefill envelope, with needsReview,
    // and count_needs_review reads it.
    expect(ledgerGuide).toContain("ROW PROVENANCE LIVES IN THE PREFILL ENVELOPE");
    expect(ledgerGuide).toContain("needsReview");
    expect(ledgerGuide).toContain("count_needs_review");
    // §5.3 audit: a table plus a chained rank form, not a multi_select.
    expect(convergenceGuide).toContain("NOT a multi_select");
    expect(convergenceGuide).toContain("RANKING IS THE NEXT FORM");
    // §5.5: never send the grid to the model.
    expect(matrixGuide).toContain("NEVER SEND THE GRID BACK");
  });

  it("rejects an archetype outside the closed vocabulary", async () => {
    const { call, close } = await connect();
    // The SDK validates `inputSchema` before dispatch, so this never reaches
    // the handler — and the enum's own error names all five legal values.
    const result = await call("get_form_guide", { archetype: "questionnaire" });
    await close();
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("ledger");
    expect(firstText(result)).toContain("plan_confirmation");
  });
});
