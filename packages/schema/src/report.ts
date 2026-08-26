/**
 * The answers, rendered for the AGENT to read (§3, §7.2).
 *
 * Why this exists at all: the app pushes the structured payload on
 * `ui/update-model-context`, and the host is free to defer, drop or never
 * surface it — the first field session found exactly that, an agent that could
 * see "form displayed" and not one answer. So the answers also have to be
 * PULLABLE: a model-visible tool reads them back out of the form's Durable
 * Object, and this is the rendering it returns.
 *
 * It is prose, not JSON, for two reasons. The obvious one is tokens. The real
 * one is §4.1: an answer is a label the user saw plus the value the agent
 * declared, and the agent needs both — the label to talk to the user about it,
 * the value to branch on. `Label [id]: Human label (machine_value)` carries the
 * pair on one line, and the machine value is only repeated when it differs from
 * the label, because a form written in the user's language repeats itself
 * otherwise.
 *
 * Lives in `@mcpq/schema` and not in the Worker because resolving a path to its
 * field, and a value to its option label, is meta-schema knowledge (§8.1) — the
 * same reason the validator lives here.
 */

import { canonicalPath, parsePath } from "./paths.js";
import { optionsOf, resolvePath } from "./resolve.js";
import type { Answers, Form, Value } from "./types.js";

/** One answered or empty leaf, ready to print. */
export type AnswerLine = {
  path: string;
  /** The field's own label — free text, exactly as the agent wrote it (§4.1). */
  label: string;
  /** What the user saw. `null` for an empty answer. */
  display: string | null;
  /** The machine value, when it is not the same string as `display`. */
  machine: string | null;
  note: string | null;
};

export type AnswerReport = {
  lines: AnswerLine[];
  answered: number;
  empty: number;
  notes: number;
  /** The rendering. What a tool result carries. */
  text: string;
};

/** Guard on the tool result: §7.5 spills a very large result to a file pointer. */
const MAX_TEXT_CHARS = 20_000;

/**
 * A human name for the leaf at `path`.
 *
 * `resolvePath` is the only thing that knows how to get there, and it answers
 * for every §4.5 target kind — including the ones a bare field label cannot
 * name, a matrix cell and an allocation member. An unresolvable path is not an
 * error here: a stored answer whose field a re-render has since removed is inert
 * (§4.6), and printing the path is a better answer than dropping the line.
 */
function labelOf(form: Form, path: string): string {
  const resolved = resolvePath(form, path);
  if (!resolved.ok) return path;
  const target = resolved.target;
  switch (target.kind) {
    case "field":
      return target.field.type === "info"
        ? (target.field.label ?? target.field.id)
        : target.field.label;
    case "section":
      return target.section.title;
    case "row": {
      const row =
        target.container.type === "table"
          ? target.container.rows.find((candidate) => candidate.id === target.rowId)
          : undefined;
      return row?.label ?? target.rowId;
    }
    case "matrix_row":
      return `${target.field.label} · ${target.row.label}`;
    case "matrix_cell":
      return `${target.field.label} · ${target.row.label} × ${target.col.label}`;
    case "rank_item":
      return `${target.field.label} · ${target.item.label}`;
    case "allocation_member":
      return `${target.field.label} · ${target.member.label}`;
  }
}

/**
 * The label the user saw for one scalar value.
 *
 * Matching a declared value by EQUALITY is explicitly allowed (§4.1) — what is
 * forbidden is reading meaning out of the label. So this looks the value up in
 * the option set, the rank items, the skip options and the boolean's own free
 * text, and falls back to the value itself. Nothing is parsed.
 */
function displayScalar(form: Form, path: string, value: Value): string {
  const resolved = resolvePath(form, path);
  if (!resolved.ok) return String(value);
  const target = resolved.target;

  const options = optionsOf(target);
  const option = options?.find((candidate) => candidate.value === value);
  if (option) return option.label;

  if (target.kind === "field") {
    const field = target.field;
    if ("skipOptions" in field) {
      const skip = field.skipOptions?.find((candidate) => candidate.value === value);
      // The skip affordance is an ordinary option (§4.3), and worth marking as
      // one: "TBD" reads very differently from a real choice.
      if (skip) return `${skip.label} (skipped)`;
    }
    if (field.type === "boolean" && typeof value === "boolean") {
      const label = value ? field.trueLabel : field.falseLabel;
      if (label) return label;
    }
    if (field.type === "rank" && typeof value === "string") {
      const item = field.items.find((candidate) => candidate.id === value);
      if (item) return item.label;
    }
    if (field.type === "number" || field.type === "slider" || field.type === "allocation") {
      const unit = "unit" in field ? field.unit : undefined;
      if (unit) return `${value} ${unit}`;
    }
  }
  if (target.kind === "allocation_member" && target.field.unit) {
    return `${value} ${target.field.unit}`;
  }
  return String(value);
}

function isScalar(value: unknown): value is Value {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

/**
 * A value, as the user saw it. Composite shapes are the closed set the engine
 * can produce: an ordered id array (`rank`), a value array (`multi_select`) and
 * `{ start, end }` (`date_range`). Anything else prints as compact JSON rather
 * than being guessed at.
 */
function displayValue(form: Form, path: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (isScalar(value)) return displayScalar(form, path, value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value.map((entry) => displayValue(form, path, entry)).join(", ");
  }
  if (typeof value === "object") {
    const range = value as { start?: unknown; end?: unknown };
    if (typeof range.start === "string" || typeof range.end === "string") {
      return `${range.start ?? "?"} → ${range.end ?? "?"}`;
    }
  }
  return JSON.stringify(value);
}

/** The machine form, or `null` when the display already says it. */
function machineValue(value: unknown, display: string): string | null {
  if (value === null || value === undefined) return null;
  if (isScalar(value)) return String(value) === display ? null : JSON.stringify(value);
  if (Array.isArray(value)) {
    const compact = value.map((entry) => JSON.stringify(entry)).join(", ");
    return compact === display ? null : compact;
  }
  return JSON.stringify(value);
}

/**
 * Document order, so the report reads like the form the user filled.
 *
 * The key is the position of the path's ROOT field, which is the part of a §4.5
 * path before the first bracket; leaves inside one container keep their stored
 * order after that. Paths whose root the form no longer declares sort last —
 * they are stale rows, and they belong at the bottom, not interleaved.
 */
function documentOrder(form: Form): (path: string) => number {
  const position = new Map<string, number>();
  let index = 0;
  for (const section of form.sections) {
    for (const field of section.fields) {
      position.set(field.id, index);
      index += 1;
    }
  }
  return (path) => {
    const parsed = parsePath(path);
    const root = parsed.ok ? (canonicalPath(parsed.path).split("[")[0] ?? path) : path;
    return position.get(root) ?? Number.MAX_SAFE_INTEGER;
  };
}

/**
 * Renders the stored answers.
 *
 * Every path in the map appears, empty ones included: §4.6's "not rendered =
 * empty" makes an absent answer a real answer, and an agent that cannot see
 * which questions came back blank will re-ask them in prose.
 */
export function reportAnswers(form: Form, answers: Answers): AnswerReport {
  const order = documentOrder(form);
  const paths = Object.keys(answers).sort((a, b) => {
    const delta = order(a) - order(b);
    return delta !== 0 ? delta : a.localeCompare(b);
  });

  const lines: AnswerLine[] = [];
  let answered = 0;
  let empty = 0;
  let notes = 0;

  for (const path of paths) {
    const entry = answers[path];
    if (!entry) continue;
    const note = entry.note ?? null;
    if (note) notes += 1;

    if (entry.state === "answered") {
      answered += 1;
      const display = displayValue(form, path, entry.value);
      lines.push({
        path,
        label: labelOf(form, path),
        display,
        machine: machineValue(entry.value, display),
        note,
      });
    } else {
      empty += 1;
      lines.push({ path, label: labelOf(form, path), display: null, machine: null, note });
    }
  }

  const total = answered + empty;
  const head = `${answered} of ${total} answered${empty > 0 ? `, ${empty} left empty` : ""}${notes > 0 ? `, ${notes} with a note` : ""}.`;

  const body: string[] = [];
  for (const line of lines) {
    const value = line.display === null ? "(empty)" : line.display;
    const machine = line.machine ? ` [${line.machine}]` : "";
    body.push(`${line.label} <${line.path}>: ${value}${machine}`);
    if (line.note) body.push(`    note: ${line.note}`);
  }

  let text = body.length > 0 ? `${head}\n\n${body.join("\n")}` : head;
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n… truncated at ${MAX_TEXT_CHARS} characters; ${lines.length} answers in total.`;
  }

  return { lines, answered, empty, notes, text };
}
