import type { InjectionKey, Ref } from "vue";

export type TreeDropPlacement = "before" | "inside" | "after";
export type TreeNodeKind = "collection" | "request";

/** Shared drag and keyboard reorder behavior for recursive workspace-tree rows. */
export interface WorkspaceTreeReorderContext {
  readonly draggedNodeId: Ref<string | null>;
  readonly dropTargetNodeId: Ref<string | null>;
  readonly dropPlacement: Ref<TreeDropPlacement | null>;
  startDrag(
    event: DragEvent,
    nodeId: string,
    parentCollectionId: string | null,
    nodeKind: TreeNodeKind,
  ): void;
  updateDropTarget(
    event: DragEvent,
    nodeId: string,
    parentCollectionId: string | null,
    nodeKind: TreeNodeKind,
  ): void;
  finishDrop(
    event: DragEvent,
    nodeId: string,
    parentCollectionId: string | null,
    nodeKind: TreeNodeKind,
  ): void;
  cancelDrag(): void;
  moveByKeyboard(
    nodeId: string,
    parentCollectionId: string | null,
    offset: -1 | 1,
  ): void;
  indentByKeyboard(nodeId: string, parentCollectionId: string | null): void;
  outdentByKeyboard(nodeId: string, parentCollectionId: string | null): void;
}

export const workspaceTreeReorderKey: InjectionKey<WorkspaceTreeReorderContext> =
  Symbol("workspace-tree-reorder");
