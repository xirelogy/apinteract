import { onBeforeUnmount } from "vue";

export interface TreeNavigation {
  /** Maintains one roving tree-item tab stop as focus changes. */
  handleFocusIn(event: FocusEvent): void;
  /** Applies the WAI-ARIA directional, edge, expansion, and typeahead keys. */
  handleKeydown(event: KeyboardEvent): void;
}

/**
 * Provides DOM-local tree navigation without taking ownership of domain
 * selection, lazy loading, or expansion state.
 */
export function useTreeNavigation(): TreeNavigation {
  let typeaheadQuery = "";
  let typeaheadResetTimer: number | undefined;

  onBeforeUnmount(() => {
    if (typeaheadResetTimer !== undefined) {
      window.clearTimeout(typeaheadResetTimer);
    }
  });

  /** Returns visible enabled tree items in rendered navigation order. */
  function treeItems(tree: HTMLElement): HTMLButtonElement[] {
    return [
      ...tree.querySelectorAll<HTMLButtonElement>(
        '[role="treeitem"]:not(:disabled)',
      ),
    ];
  }

  /** Focuses one item and makes it the only tree item in the tab sequence. */
  function focusItem(items: readonly HTMLButtonElement[], index: number): void {
    const item = items[index];
    if (item === undefined) {
      return;
    }
    for (const candidate of items) {
      candidate.tabIndex = candidate === item ? 0 : -1;
    }
    item.focus();
  }

  /** Clicks the pointer affordance associated with one expandable item. */
  function toggleItem(item: HTMLButtonElement): void {
    item
      .closest<HTMLElement>(".workspace-tree-row")
      ?.querySelector<HTMLButtonElement>(".tree-toggle-button")
      ?.click();
  }

  /** Finds and focuses the next enabled item matching the typeahead buffer. */
  function focusTypeahead(
    items: readonly HTMLButtonElement[],
    currentIndex: number,
    character: string,
  ): void {
    if (typeaheadResetTimer !== undefined) {
      window.clearTimeout(typeaheadResetTimer);
    }
    typeaheadQuery += character.toLocaleLowerCase();
    const startOffset = typeaheadQuery.length > 1 ? 0 : 1;
    let match = -1;
    for (
      let offset = startOffset;
      offset < items.length + startOffset;
      offset += 1
    ) {
      const index = (currentIndex + offset) % items.length;
      if (
        items[index]?.dataset.treeText
          ?.toLocaleLowerCase()
          .startsWith(typeaheadQuery) === true
      ) {
        match = index;
        break;
      }
    }
    if (match !== -1) {
      focusItem(items, match);
    }
    typeaheadResetTimer = window.setTimeout(() => {
      typeaheadQuery = "";
      typeaheadResetTimer = undefined;
    }, 700);
  }

  /** Maintains one roving tree-item tab stop as focus changes. */
  function handleFocusIn(event: FocusEvent): void {
    const item =
      event.target instanceof HTMLButtonElement &&
      event.target.getAttribute("role") === "treeitem"
        ? event.target
        : null;
    if (item === null) {
      return;
    }
    const tree = event.currentTarget;
    if (!(tree instanceof HTMLElement)) {
      return;
    }
    for (const candidate of treeItems(tree)) {
      candidate.tabIndex = candidate === item ? 0 : -1;
    }
  }

  /** Applies the WAI-ARIA directional, edge, expansion, and typeahead keys. */
  function handleKeydown(event: KeyboardEvent): void {
    const item =
      event.target instanceof HTMLButtonElement &&
      event.target.getAttribute("role") === "treeitem"
        ? event.target
        : null;
    const tree = event.currentTarget;
    if (item === null || !(tree instanceof HTMLElement)) {
      return;
    }
    const items = treeItems(tree);
    const currentIndex = items.indexOf(item);
    if (currentIndex === -1) {
      return;
    }
    if (event.key.length === 1 && event.key.trim() !== "") {
      focusTypeahead(items, currentIndex, event.key);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(items, Math.min(currentIndex + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(items, Math.max(currentIndex - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(items, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items, items.length - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (item.getAttribute("aria-expanded") === "false") {
        toggleItem(item);
      } else if (item.getAttribute("aria-expanded") === "true") {
        const currentLevel = Number(item.getAttribute("aria-level"));
        const nextItem = items[currentIndex + 1];
        if (Number(nextItem?.getAttribute("aria-level")) > currentLevel) {
          focusItem(items, currentIndex + 1);
        }
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (item.getAttribute("aria-expanded") === "true") {
        toggleItem(item);
      } else {
        const parentId = item.dataset.treeParentId;
        const parentIndex = items.findIndex(
          (candidate) => candidate.dataset.treeNodeId === parentId,
        );
        if (parentIndex !== -1) {
          focusItem(items, parentIndex);
        }
      }
    }
  }

  return { handleFocusIn, handleKeydown };
}
