/**
 * `rank` — drag to prioritise (§4.2).
 *
 * "Position IS the value, so it can never also be the address" (§4.5): the items
 * are addressed by their declared ids and the ANSWER is the ordered array of
 * those ids, stored at the field's own path. One leaf, one answer, no ordinals
 * anywhere.
 *
 * dnd-kit, per §8 ("prefer headless libraries"), with its keyboard sensor wired
 * up — a drag-only reorder is unusable for anyone who cannot drag, and §5.5's
 * "required for accessibility anyway" applies here just as much.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Member, RankField } from "@gather/schema";
import { memo, useMemo } from "react";
import { useActions, useDisabled, useEffective } from "../state";

/** The declared order, reconciled with whatever the answer holds. */
export function rankOrder(field: RankField, value: unknown): string[] {
  const declared = field.items.map((item) => item.id);
  if (!Array.isArray(value)) return declared;
  const known = value.filter((entry): entry is string => declared.includes(entry as string));
  // Anything the agent added since, or an id the answer never mentioned, keeps
  // its declared position at the end rather than vanishing.
  return [...known, ...declared.filter((id) => !known.includes(id))];
}

const Row = memo(function Row({
  item,
  position,
  disabled,
}: {
  item: Member;
  position: number;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      className="rank-row"
      data-dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="rank-position" aria-hidden="true">
        {position}
      </span>
      <span className="grow">
        <span className="tile-label">{item.label}</span>
        {item.description ? <span className="tile-description">{item.description}</span> : null}
      </span>
      <button
        type="button"
        className="rank-handle"
        disabled={disabled}
        // dnd-kit's keyboard sensor drives this: space picks the item up, the
        // arrows move it, space drops it, escape cancels.
        aria-label={`Reorder ${item.label} — currently ${position}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
    </li>
  );
});

export const RankFieldView = memo(function RankFieldView({
  field,
  path,
  label,
}: {
  field: RankField;
  path: string;
  label: string;
}) {
  const value = useEffective(path);
  const disabled = useDisabled(path);
  const actions = useActions();
  const order = useMemo(() => rankOrder(field, value), [field, value]);
  const byId = useMemo(() => new Map(field.items.map((item) => [item.id, item])), [field.items]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    actions.setAnswer(path, arrayMove(order, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ol className="rank-list" aria-label={label}>
          {order.map((id, index) => {
            const item = byId.get(id);
            return item ? (
              <Row key={id} item={item} position={index + 1} disabled={disabled} />
            ) : null;
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
});
