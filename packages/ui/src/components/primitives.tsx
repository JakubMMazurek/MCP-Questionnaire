/**
 * Vendored, shadcn-shaped primitives — only the ones this build actually uses.
 *
 * No Radix here: the ledger needs no portal, no popover and no dialog, and
 * inline cards may not have menus at all (§7.3). The visual language is §8.2 as
 * defined by the §5.1 mockup: segmented controls are the default answer
 * affordance, counters are pills, the note icon has a filled state, and the one
 * accent on the surface is the primary action.
 */

// biome-ignore-all lint/a11y/useSemanticElements: the segmented control is
// buttons inside a radiogroup, not radio inputs — that is the §5.1 mockup's
// affordance, and clicking the selected segment again clears the answer, which
// a native radio cannot express.

import type { Option, Prefill, Value } from "@gather/schema";
import { memo, type ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* provenance chip — the only semantic color system (§8.2)                    */
/* -------------------------------------------------------------------------- */

const CHIP_CLASS = {
  inferred: "chip-inferred",
  user: "chip-user",
  existing: "chip-existing",
  default: "chip-existing",
} as const;

function chipLabel(prefill: Prefill): string {
  switch (prefill.source) {
    case "inferred":
      return prefill.confidence ? `inferred · ${prefill.confidence}` : "inferred";
    case "user":
      return "you said";
    case "existing":
      return "existing";
    case "default":
      return "default";
  }
}

/** `rationale` rides on the title, per §4.7 ("on hover/expand"). */
export const ProvenanceChip = memo(function ProvenanceChip({ prefill }: { prefill: Prefill }) {
  return (
    <span
      className={cn("chip", CHIP_CLASS[prefill.source])}
      {...(prefill.rationale ? { title: prefill.rationale } : {})}
    >
      {chipLabel(prefill)}
    </span>
  );
});

/* -------------------------------------------------------------------------- */
/* counter pill                                                               */
/* -------------------------------------------------------------------------- */

export type PillTone = "warn" | "clear" | "neutral";

export function Pill({
  tone,
  label,
  children,
}: {
  tone: PillTone;
  /** Accessible name — the whole counter read as one thing ("5 needing review"). */
  label?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn("pill", tone === "clear" && "pill-clear", tone === "neutral" && "pill-neutral")}
      {...(label ? { "aria-label": label } : {})}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* segmented control                                                          */
/* -------------------------------------------------------------------------- */

export type Segment = Option & { skip?: boolean };

export type SegmentedProps = {
  segments: readonly Segment[];
  value: unknown;
  disabled?: boolean;
  label: string;
  /** Picking the segment that is already selected clears the answer (§4.3). */
  onPick: (value: Value) => void;
  onClear: () => void;
};

export const Segmented = memo(function Segmented({
  segments,
  value,
  disabled,
  label,
  onPick,
  onClear,
}: SegmentedProps) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {segments.map((segment) => {
        const selected = value !== undefined && segment.value === value;
        return (
          <button
            key={String(segment.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            className={cn(segment.skip && "seg-skip")}
            {...(segment.description ? { title: segment.description } : {})}
            onClick={() => (selected ? onClear() : onPick(segment.value))}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* buttons, skeletons                                                         */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  primary,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={cn("btn", primary && "btn-primary")}
      disabled={disabled}
      onClick={onClick}
      {...(title ? { title } : {})}
    >
      {children}
    </button>
  );
}

/**
 * One line of plumbing news — a draft that will not save, a form that could not
 * be reopened. Deliberately quiet: it is never the user's problem to solve, and
 * their answers still reach the model on submit (§3).
 */
export function StatusLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="why m-0">
      {message}
    </p>
  );
}

/** Skeletons, never spinners (§7.4). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}
