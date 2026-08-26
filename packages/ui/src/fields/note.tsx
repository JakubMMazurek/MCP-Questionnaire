/**
 * The note affordance (§4.4): an icon that expands, with a visually distinct
 * filled state. Never forty visible textareas — that makes a form look like
 * homework.
 *
 * The note is anchored to the ROW inside a table, which is the anchor the agent
 * gets back ("you flagged rollout timing: 'depends on Legal'"). Writing one is a
 * touch on that path, so it also clears the row's needs-review counter.
 */

import { memo, useEffect, useId, useRef, useState } from "react";
import { useActions, useDisabled, useNote } from "../state";

export const NoteAffordance = memo(function NoteAffordance({
  path,
  label,
}: {
  path: string;
  label: string;
}) {
  const note = useNote(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const filled = Boolean(note && note.trim().length > 0);
  const expanded = open || filled;

  // Opening the icon puts the caret in the note, as the §5.1 mockup does.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="btn-icon"
        data-filled={filled}
        aria-expanded={expanded}
        aria-controls={inputId}
        title={filled ? `Note: ${note}` : `Add a note — anchored to “${label}”`}
        aria-label={filled ? `Edit the note on ${label}` : `Add a note to ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        ✎
      </button>
      {expanded ? (
        <div className="subrow">
          <input
            ref={input}
            id={inputId}
            className="field-input note-input"
            type="text"
            value={note ?? ""}
            disabled={disabled}
            placeholder="note for Claude, anchored to this row…"
            onChange={(event) => actions.setNote(path, event.target.value)}
          />
        </div>
      ) : null}
    </>
  );
});
