import { ref, type Ref } from "vue";

interface RowReorderOptions {
  /** Returns whether a row participates in drag and keyboard movement. */
  canMove(index: number): boolean;
  /** Moves one row to the requested array index. */
  move(fromIndex: number, toIndex: number): void;
  /** Returns whether editing is currently unavailable. */
  isDisabled(): boolean;
}

/** Coordinates one editable table's native drag and keyboard row movement. */
export interface RowReorderController {
  readonly draggedIndex: Ref<number | null>;
  readonly dropIndex: Ref<number | null>;
  readonly classes: (index: number) => Record<string, boolean>;
  startDrag(event: DragEvent, index: number): void;
  updateDropTarget(event: DragEvent, index: number): void;
  finishDrop(event: DragEvent): void;
  cancelDrag(): void;
  moveByKeyboard(index: number, offset: -1 | 1): void;
}

/** Creates reusable drag/drop state for a list that has a trailing blank row. */
export function useRowReorder(
  options: RowReorderOptions,
): RowReorderController {
  const draggedIndex = ref<number | null>(null);
  const dropIndex = ref<number | null>(null);

  /** Clears transient drag state after a completed or cancelled gesture. */
  function cancelDrag(): void {
    draggedIndex.value = null;
    dropIndex.value = null;
  }

  /** Starts dragging one meaningful row. */
  function startDrag(event: DragEvent, index: number): void {
    if (options.isDisabled() || !options.canMove(index)) {
      event.preventDefault();
      return;
    }
    draggedIndex.value = index;
    event.dataTransfer?.setData("text/plain", String(index));
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  /** Tracks a before/after insertion point on a meaningful row. */
  function updateDropTarget(event: DragEvent, index: number): void {
    if (draggedIndex.value === null) {
      return;
    }
    if (draggedIndex.value === index || options.isDisabled()) {
      dropIndex.value = null;
      return;
    }
    const row = event.currentTarget;
    if (!(row instanceof HTMLElement)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "move";
    }
    const bounds = row.getBoundingClientRect();
    const insertionIndex =
      event.clientY < bounds.top + bounds.height / 2 ? index : index + 1;
    if (!options.canMove(index) && insertionIndex !== index) {
      dropIndex.value = null;
      return;
    }
    if (
      insertionIndex === draggedIndex.value ||
      insertionIndex === draggedIndex.value + 1
    ) {
      dropIndex.value = null;
      return;
    }
    dropIndex.value = insertionIndex;
  }

  /** Commits the requested row insertion while preserving relative order. */
  function finishDrop(event: DragEvent): void {
    event.preventDefault();
    const fromIndex = draggedIndex.value;
    const insertionIndex = dropIndex.value;
    cancelDrag();
    if (fromIndex === null || insertionIndex === null || options.isDisabled()) {
      return;
    }
    let toIndex = insertionIndex;
    if (fromIndex < toIndex) toIndex -= 1;
    if (fromIndex !== toIndex) options.move(fromIndex, toIndex);
  }

  /** Moves to the nearest meaningful row for keyboard users. */
  function moveByKeyboard(index: number, offset: -1 | 1): void {
    if (options.isDisabled() || !options.canMove(index)) return;
    let target = index + offset;
    while (target >= 0 && options.canMove(target) === false) {
      target += offset;
    }
    if (target >= 0 && options.canMove(target)) {
      options.move(index, target);
    }
  }

  return {
    draggedIndex,
    dropIndex,
    classes: (index) => ({
      "is-row-dragging": draggedIndex.value === index,
      "is-row-drop-before": dropIndex.value === index,
    }),
    startDrag,
    updateDropTarget,
    finishDrop,
    cancelDrag,
    moveByKeyboard,
  };
}
