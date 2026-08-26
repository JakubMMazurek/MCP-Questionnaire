/**
 * The app: one of five states (§7.3, §7.4, §6.3).
 *
 *  loading    — skeletons, never spinners, while the schema streams in
 *  invalid    — a plain "could not be rendered" card; never garbage
 *  idle       — the input was not a form at all: draw nothing (see the bridge's
 *               `isFormAttempt`). Never confuse this with `invalid`, which
 *               blames the agent for a schema in front of the user
 *  cancelled  — the form, frozen
 *  ready      — inline (the elicitation card, or a summary), or the full surface
 *
 * Inline is TWO surfaces, and which one you get is a property of the form, not
 * of the archetype (§7.3):
 *
 *  - A SMALL form renders for real — the §5.2 elicitation card. Fields inline,
 *    auto-fit height, no nested scroll, one primary action. That is the whole
 *    point of an elicitation form: it replaces three turns of Q&A, and a card
 *    that only says "open me" replaces nothing.
 *  - Anything DENSE gets the summary card and a fullscreen button. Vertical pan
 *    inside an inline app belongs to the conversation scroll, so a surface that
 *    cannot fit its own height must not be drawn there.
 *
 * The line between them is structural: more than eight answerable fields, or any
 * `table`/`matrix` — a grid has no honest inline rendering at all.
 */

import type { Form } from "@mcpq/schema";
import { useEffect, useRef } from "react";
import { Button, Pill, Skeleton, StatusLine } from "./components/primitives";
import type { EngineState } from "./engine/index.js";
import { FormShell } from "./FormShell";
import { CounterPill, isComputedField } from "./fields/field";
import { useBridge, useDraftStatus, useEngine, useFrozen, useMobile } from "./state";

function Loading() {
  // A reopened form pulls its own state (§7.2); if that pull fails the
  // skeletons stay and the status line says so, rather than flashing a wrong
  // form or an empty one.
  const status = useDraftStatus();
  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-3 p-4" aria-busy={!status}>
      {status ? (
        <StatusLine message={status} />
      ) : (
        <>
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
          <div className="mt-2 flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
          <span className="sr-only">Waiting for the form</span>
        </>
      )}
    </div>
  );
}

function Invalid() {
  const diagnostics = useEngine((state) => state.diagnostics);
  return (
    <div className="mx-auto max-w-[640px] p-4">
      <h1 className="m-0 text-[length:var(--font-heading-sm-size)] font-[var(--font-weight-semibold)]">
        This form could not be rendered
      </h1>
      <p className="why m-0">
        The schema did not validate, so nothing is shown rather than something wrong. Tell me what
        you need in chat and I will ask properly.
      </p>
      {diagnostics.length > 0 ? (
        <details className="mt-3 text-[length:var(--font-text-sm-size)] text-muted">
          <summary>What went wrong</summary>
          <ul className="m-0 pl-4">
            {diagnostics.slice(0, 8).map((diagnostic) => (
              <li key={`${diagnostic.code}-${diagnostic.location}`}>
                {/* The LOCATION, not just the sentence. "Expected number, got
                    nothing" names no field and teaches nobody anything —
                    CLAUDE.md's rule is that every error says where. */}
                <code className="font-[family-name:var(--font-mono)]">{diagnostic.location}</code>
                {" — "}
                {diagnostic.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function CancelledBanner() {
  return (
    <div className="border-line border-b px-4 py-2">
      <Pill tone="neutral">cancelled — this form is frozen</Pill>
    </div>
  );
}

/**
 * §7.3 — is this form small enough to render inside the conversation?
 *
 * On a PHONE the answer is almost always no, and the reason is not aesthetics:
 * "vertical pan gestures inside an inline app go to the conversation scroll, so
 * inline apps must fit their content height; request fullscreen if you need
 * your own scroll viewport". Eight fields do not fit ~340 px of phone-width
 * card, so the card grew its own nested scroll and fought the conversation for
 * every drag — which is exactly what the field session looked like. Four is
 * what actually fits without one.
 *
 * The composites go the same way for the same reason as `table` and `matrix`
 * already do: a rank list you drag, a split you balance and a row list you
 * extend all need room and a scroll of their own. "Editing is a
 * desktop/tablet affordance" is the spec's own line about grids; it is just as
 * true of these.
 */
export function fitsInline(form: Form, platform: Platform = "web"): boolean {
  const mobile = platform === "mobile";
  let answerable = 0;
  for (const section of form.sections) {
    for (const field of section.fields) {
      if (field.type === "table" || field.type === "matrix") return false;
      if (mobile && (field.type === "rank" || field.type === "allocation")) return false;
      if (mobile && field.type === "repeatable") return false;
      if (field.type === "info" || field.type === "computed") continue;
      answerable += 1;
    }
  }
  return answerable <= (mobile ? INLINE_FIELD_LIMIT_MOBILE : INLINE_FIELD_LIMIT);
}

/** `hostContext.platform`, as the store holds it (§7.4). */
type Platform = EngineState["platform"];

export const INLINE_FIELD_LIMIT = 8;
/** §7.3 — what fits a phone-width card without a nested scroll of its own. */
export const INLINE_FIELD_LIMIT_MOBILE = 4;

function InlineCard() {
  const form = useEngine((state) => state.form);
  const bridge = useBridge();
  const frozen = useFrozen();
  const mobile = useMobile();
  if (!form) return null;
  const counters = form.sections.flatMap((section) => section.fields.filter(isComputedField));

  return (
    <div className="flex flex-col gap-2 p-4">
      <h1 className="m-0 text-[length:var(--font-heading-sm-size)] font-[var(--font-weight-semibold)]">
        {form.title}
      </h1>
      {form.description ? <p className="why m-0">{form.description}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {counters.map((field) => (
          <CounterPill key={field.id} field={field} />
        ))}
      </div>
      <div className="bar">
        <Button
          primary
          disabled={frozen}
          onClick={() => void bridge?.requestDisplayMode("fullscreen")}
        >
          {/* On a phone "fullscreen" describes the mechanism, not the act. */}
          {mobile ? "Open the form" : "Review in fullscreen"}
        </Button>
        <span className="escape">…or just tell me in chat</span>
      </div>
    </div>
  );
}

export function App() {
  const status = useEngine((state) => state.status);
  const displayMode = useEngine((state) => state.displayMode);
  const form = useEngine((state) => state.form);
  const platform = useEngine((state) => state.platform);
  const bridge = useBridge();
  const frame = useRef<HTMLDivElement | null>(null);

  // Inline auto-fit: report our own height so the host can size the card (§7.3).
  useEffect(() => {
    const element = frame.current;
    if (!element || !bridge) return;
    return bridge.observe(element);
  }, [bridge]);

  return (
    <div ref={frame}>
      {status === "cancelled" ? <CancelledBanner /> : null}
      {status === "loading" ? <Loading /> : null}
      {status === "invalid" ? <Invalid /> : null}
      {status === "ready" || status === "cancelled" ? (
        displayMode === "inline" ? (
          form && fitsInline(form, platform) ? (
            <FormShell compact />
          ) : (
            <InlineCard />
          )
        ) : (
          <FormShell />
        )
      ) : null}
    </div>
  );
}
