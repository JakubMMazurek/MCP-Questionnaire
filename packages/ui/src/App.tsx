/**
 * The app: one of four states (§7.3, §7.4, §6.3).
 *
 *  loading    — skeletons, never spinners, while the schema streams in
 *  invalid    — a plain "could not be rendered" card; never garbage
 *  cancelled  — the form, frozen
 *  ready      — inline summary card, or the full surface in fullscreen
 *
 * Inline is a SUMMARY surface (§7.3): auto-fit height, no nested scroll, two
 * actions, and a button that asks the host for fullscreen. The dense ledger is
 * never rendered inline — vertical pan inside an inline app belongs to the
 * conversation scroll.
 */

import { useEffect, useRef } from "react";
import { Button, Pill, Skeleton, StatusLine } from "./components/primitives";
import { FormShell } from "./FormShell";
import { CounterPill, isComputedField } from "./fields/field";
import { useBridge, useDraftStatus, useEngine, useFrozen } from "./state";

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
              <li key={`${diagnostic.code}-${diagnostic.location}`}>{diagnostic.message}</li>
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

function InlineCard() {
  const form = useEngine((state) => state.form);
  const bridge = useBridge();
  const frozen = useFrozen();
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
          Review in fullscreen
        </Button>
        <span className="escape">…or just tell me in chat</span>
      </div>
    </div>
  );
}

export function App() {
  const status = useEngine((state) => state.status);
  const displayMode = useEngine((state) => state.displayMode);
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
          <InlineCard />
        ) : (
          <FormShell />
        )
      ) : null}
    </div>
  );
}
