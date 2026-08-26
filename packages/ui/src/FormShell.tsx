/**
 * The generic form shell: title, description, computed counter pills, the
 * section rail (§4.8, fullscreen and more than one section), the sections, and
 * the action bar.
 *
 * The action bar is the §5.1 mockup: bulk affirm is the PRIMARY action on a
 * ledger — with forty rows where thirty-eight are right, that is the primary
 * interaction — then submit, then the chat escape hatch, which costs nothing and
 * turns a mistriggered form from a dead end into a minor annoyance (§5.6).
 *
 * Submit is never gated by `require` (§4.6/§6.3). Only malformed values block.
 */

import type { Form, Section } from "@gather/schema";
import { memo, useState } from "react";
import { Button } from "./components/primitives";
import {
  computeContext,
  effectiveValue,
  highConfidence,
  isVisible,
  malformedValues,
  needsReviewPaths,
} from "./engine/index.js";
import { CounterPill, FieldView, isComputedField } from "./fields/field";
import { useBridge, useEngine, useEngineStore, useFrozen, useVisible } from "./state";

const SECTION_STATUS_DOT = {
  untouched: "bg-line",
  progress: "bg-[var(--color-text-warning)]",
  complete: "bg-[var(--color-text-success)]",
  empty: "bg-line-soft",
} as const;

function useSectionStatus(sectionId: string): keyof typeof SECTION_STATUS_DOT {
  return useEngine((state) => {
    const values = { answers: state.answers, prefill: state.prefill, overlays: state.effects };
    const leaves = state.leaves.filter(
      (leaf) => leaf.section.id === sectionId && isVisible(state.effects, leaf.path),
    );
    if (leaves.length === 0) return "empty";
    const answered = leaves.filter((leaf) => effectiveValue(values, leaf.path).present).length;
    if (answered === 0) return "untouched";
    return answered === leaves.length ? "complete" : "progress";
  });
}

const RailEntry = memo(function RailEntry({ section }: { section: Section }) {
  const status = useSectionStatus(section.id);
  const visible = useVisible(section.id);
  if (!visible) return null;
  return (
    <li className="flex items-center gap-2 py-1">
      <span
        className={`inline-block size-2 rounded-full ${SECTION_STATUS_DOT[status]}`}
        aria-hidden="true"
      />
      <a
        href={`#section-${section.id}`}
        className="text-[length:var(--font-text-sm-size)] text-muted no-underline hover:text-ink"
      >
        {section.title}
      </a>
      <span className="sr-only">{status}</span>
    </li>
  );
});

const SectionView = memo(function SectionView({ section }: { section: Section }) {
  const visible = useVisible(section.id);
  const [open, setOpen] = useState(section.initially !== "collapsed");
  if (!visible) return null;
  const collapsible = section.initially === "collapsed";

  return (
    <section id={`section-${section.id}`} className="mb-4">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-[length:var(--font-heading-sm-size)] font-[var(--font-weight-semibold)]">
          {section.title}
        </h2>
        {collapsible ? (
          <button
            type="button"
            className="btn-icon"
            aria-expanded={open}
            aria-label={open ? `Collapse ${section.title}` : `Expand ${section.title}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "−" : "+"}
          </button>
        ) : null}
      </div>
      {section.description ? <p className="why m-0">{section.description}</p> : null}
      {open ? (
        <div className={section.layout === "two_col" ? "grid gap-x-6 sm:grid-cols-2" : undefined}>
          {section.fields.map((field) => (
            <FieldView key={field.id} field={field} />
          ))}
        </div>
      ) : null}
    </section>
  );
});

function ActionBar({ form }: { form: Form }) {
  const store = useEngineStore();
  const bridge = useBridge();
  const frozen = useFrozen();
  const [sent, setSent] = useState(false);

  const affirmable = useEngine(
    (state) => needsReviewPaths(computeContext(state), highConfidence).length,
  );
  const blocking = useEngine((state) => {
    const values = { answers: state.answers, prefill: state.prefill, overlays: state.effects };
    return malformedValues(state.leaves, values, state.effects).length;
  });
  const firstBlocking = useEngine((state) => {
    const values = { answers: state.answers, prefill: state.prefill, overlays: state.effects };
    const first = malformedValues(state.leaves, values, state.effects)[0];
    return first ? `${first.label} ${first.reason}` : null;
  });

  const submit = () => {
    setSent(true);
    void bridge?.submit();
  };

  return (
    <div className="bar">
      {affirmable > 0 ? (
        <Button
          primary
          disabled={frozen || sent}
          title="Accepts the inferred values that are not marked low confidence"
          onClick={() => {
            const state = store.getState();
            state.bulkAffirm(needsReviewPaths(computeContext(state), highConfidence));
          }}
        >
          Confirm all high-confidence
        </Button>
      ) : null}
      <Button
        primary={affirmable === 0}
        disabled={blocking > 0 || frozen || sent}
        {...(firstBlocking ? { title: firstBlocking } : {})}
        onClick={submit}
      >
        {sent ? "Sent" : (form.submitLabel ?? "Submit")}
      </Button>
      {blocking > 0 ? (
        <span className="text-[length:var(--font-text-sm-size)] text-[var(--color-text-danger)]">
          {firstBlocking}
        </span>
      ) : null}
      <span className="escape">…or just tell me in chat</span>
    </div>
  );
}

export function FormShell() {
  const form = useEngine((state) => state.form);
  if (!form) return null;
  const counters = form.sections.flatMap((section) => section.fields.filter(isComputedField));
  const railed = form.sections.length > 1;

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-2 p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="m-0 text-[length:var(--font-heading-md-size)] font-[var(--font-weight-semibold)] leading-tight">
            {form.title}
          </h1>
          {form.description ? <p className="why m-0">{form.description}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {counters.map((field) => (
            <CounterPill key={field.id} field={field} />
          ))}
        </div>
      </header>

      <div className={railed ? "grid gap-6 sm:grid-cols-[170px_minmax(0,1fr)]" : undefined}>
        {railed ? (
          <nav aria-label="Sections" className="hidden sm:block">
            <ul className="m-0 list-none p-0">
              {form.sections.map((section) => (
                <RailEntry key={section.id} section={section} />
              ))}
            </ul>
          </nav>
        ) : null}
        <main>
          {form.sections.map((section) => (
            <SectionView key={section.id} section={section} />
          ))}
        </main>
      </div>

      <ActionBar form={form} />
    </div>
  );
}
