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
import { memo, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

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
/* option tiles — `render: "cards"` and `render: "radio"`                     */
/* -------------------------------------------------------------------------- */

export type TilesProps = {
  options: readonly Segment[];
  value: unknown;
  disabled?: boolean;
  label: string;
  /** `cards` shows the description inline; `radio` is one dense column. */
  variant: "cards" | "radio";
  onPick: (value: Value) => void;
  onClear: () => void;
};

/**
 * Cards for ≤6 options with descriptions, radio for a dense column (§4.2).
 * Same radiogroup affordance as the segmented control, for the same reason:
 * picking the selected option again clears the answer, which a native radio
 * cannot express.
 */
export const Tiles = memo(function Tiles({
  options,
  value,
  disabled,
  label,
  variant,
  onPick,
  onClear,
}: TilesProps) {
  return (
    <div className={variant === "cards" ? "tiles" : "radios"} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = value !== undefined && option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            className={cn("tile", option.skip && "tile-skip")}
            onClick={() => (selected ? onClear() : onPick(option.value))}
          >
            <span className="tile-mark" aria-hidden="true" />
            <span className="tile-body">
              <span className="tile-label">{option.label}</span>
              {option.description ? (
                <span className="tile-description">{option.description}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* multi-select: chips and checkboxes                                         */
/* -------------------------------------------------------------------------- */

export type MultiProps = {
  options: readonly Segment[];
  /** The selected set. */
  values: readonly Value[];
  disabled?: boolean;
  label: string;
  onToggle: (value: Value) => void;
};

/** `render: "chips"` — a row of toggles. `aria-pressed`, not a radiogroup. */
export const Chips = memo(function Chips({
  options,
  values,
  disabled,
  label,
  onToggle,
}: MultiProps) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={values.includes(option.value)}
          disabled={disabled}
          className={cn("chip-toggle", option.skip && "chip-toggle-skip")}
          {...(option.description ? { title: option.description } : {})}
          onClick={() => onToggle(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
});

/** `render: "checkboxes"` — real inputs; nothing here needs a custom affordance. */
export const CheckboxList = memo(function CheckboxList({
  options,
  values,
  disabled,
  label,
  onToggle,
}: MultiProps) {
  return (
    <fieldset className="checks">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={String(option.value)} className="check">
          <input
            type="checkbox"
            checked={values.includes(option.value)}
            disabled={disabled}
            onChange={() => onToggle(option.value)}
          />
          <span>
            <span className="tile-label">{option.label}</span>
            {option.description ? (
              <span className="tile-description">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
});

/* -------------------------------------------------------------------------- */
/* combobox — `render: "list"` (§7.3 is the whole design constraint)           */
/* -------------------------------------------------------------------------- */

export type ComboBoxProps = {
  options: readonly Segment[];
  /** Selected values — one entry for single_select, any number for multi. */
  values: readonly Value[];
  multi?: boolean;
  disabled?: boolean;
  label: string;
  placeholder?: string;
  /**
   * True in fullscreen: the option list may leave the flow, and does so through
   * the TOP LAYER (a modal `<dialog>`), which escapes ancestor `overflow` inside
   * our own document — there is no portaling out of the sandbox (§7.3).
   *
   * False inline: §7.3 forbids menus and popovers in an inline card outright
   * (host clipping, z-index), so the list renders IN FLOW and the card grows,
   * which the size report then tells the host about.
   */
  layered: boolean;
  onToggle: (value: Value) => void;
  onClear: () => void;
};

const MAX_INLINE_MATCHES = 8;

export const ComboBox = memo(function ComboBox({
  options,
  values,
  multi,
  disabled,
  label,
  placeholder,
  layered,
  onToggle,
  onClear,
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement | null>(null);
  const listId = useId();

  // Matching is a plain substring test on the agent's own label text — never an
  // interpretation of it (§4.1).
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    const element = dialog.current;
    if (element?.open && typeof element.close === "function") element.close();
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!layered || !element) return;
    if (open && !element.open) {
      // `showModal` puts it in the top layer. jsdom (and an old WebView) may not
      // have it; the plain `open` attribute still shows the list, in flow.
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    if (!open && element.open && typeof element.close === "function") element.close();
  }, [open, layered]);

  const selectedLabels = options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label);
  const summary =
    selectedLabels.length > 0 ? selectedLabels.join(", ") : (placeholder ?? "Choose…");

  const list = (
    <>
      <input
        className="field-input"
        type="search"
        aria-label={`Search ${label}`}
        aria-controls={listId}
        value={query}
        placeholder="Type to filter…"
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul id={listId} className="combo-list" aria-label={label}>
        {matches.slice(0, layered ? matches.length : MAX_INLINE_MATCHES).map((option) => {
          const selected = values.includes(option.value);
          return (
            <li key={String(option.value)}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={cn("combo-option", option.skip && "combo-option-skip")}
                onClick={() => {
                  onToggle(option.value);
                  if (!multi) close();
                }}
              >
                <span className="tile-label">{option.label}</span>
                {option.description ? (
                  <span className="tile-description">{option.description}</span>
                ) : null}
              </button>
            </li>
          );
        })}
        {matches.length === 0 ? <li className="combo-empty">Nothing matches “{query}”</li> : null}
      </ul>
    </>
  );

  return (
    <div className="combo">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="combo-trigger"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={label}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className={selectedLabels.length > 0 ? undefined : "text-faint"}>{summary}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {selectedLabels.length > 0 ? (
          <button
            type="button"
            className="btn-icon"
            disabled={disabled}
            aria-label={`Clear ${label}`}
            onClick={() => {
              onClear();
              close();
            }}
          >
            ×
          </button>
        ) : null}
      </div>

      {layered ? (
        <dialog ref={dialog} className="combo-dialog" onClose={() => setOpen(false)}>
          <div className="combo-dialog-body">
            <div className="flex items-baseline justify-between gap-3">
              <strong className="text-[length:var(--font-text-sm-size)]">{label}</strong>
              <button type="button" className="btn-icon" aria-label="Close" onClick={close}>
                ×
              </button>
            </div>
            {list}
          </div>
        </dialog>
      ) : open ? (
        <div className="combo-inline">{list}</div>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* switch, preset pills, field error                                          */
/* -------------------------------------------------------------------------- */

/**
 * `boolean` with `render: "toggle"`. A switch has two states, so there is no
 * clearing gesture on it: emptiness is reachable only through the field's
 * `skipOptions`, which is the §4.3 mechanism for exactly this.
 */
export const Switch = memo(function Switch({
  value,
  trueLabel,
  falseLabel,
  disabled,
  label,
  onPick,
}: {
  value: unknown;
  trueLabel: string;
  falseLabel: string;
  disabled?: boolean;
  label: string;
  onPick: (value: boolean) => void;
}) {
  const on = value === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className="switch"
      data-empty={value === undefined}
      onClick={() => onPick(!on)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span>{on ? trueLabel : falseLabel}</span>
    </button>
  );
});

/**
 * `date`/`date_range` presets. "Named presets ('end of Q3') matter more than the
 * picker" (§4.2), so they come first and the input is beside them.
 */
export const PresetPills = memo(function PresetPills({
  options,
  value,
  disabled,
  label,
  onPick,
  onClear,
}: {
  options: readonly Segment[];
  value: unknown;
  disabled?: boolean;
  label: string;
  onPick: (value: Value) => void;
  onClear: () => void;
}) {
  return (
    <div className="presets" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = value !== undefined && option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            className={cn("preset", option.skip && "preset-skip")}
            {...(option.description ? { title: option.description } : {})}
            onClick={() => (selected ? onClear() : onPick(option.value))}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
});

/** The §6.3 gate, said where the fix happens. */
export function FieldError({ reason, label }: { reason: string | null; label?: string }) {
  if (!reason) return null;
  return (
    <span role="alert" className="field-error">
      {label ? `${label} ` : ""}
      {reason}
    </span>
  );
}

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
