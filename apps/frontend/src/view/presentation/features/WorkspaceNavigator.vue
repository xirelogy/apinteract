<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue";
import { FileUp, FolderPlus, Plus, Settings2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";
import type { CollectionChildrenState } from "@/model/domain/application";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import { useTreeNavigation } from "@/view/presentation/controls/tree/useTreeNavigation";
import CreateResourceDialog from "./CreateResourceDialog.vue";
import WorkspaceTreeNode from "./WorkspaceTreeNode.vue";
import {
  workspaceTreeReorderKey,
  type TreeDropPlacement,
  type TreeNodeKind,
} from "./workspace-tree-reorder";

type CreationKind = "workspace" | "collection";
const NO_WORKSPACE_VALUE = "__no-workspace__";

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  rootNodes: readonly TreeNode[];
  selectedCollectionId: string | null;
  collectionChildren: Readonly<Record<string, CollectionChildrenState>>;
  expandedCollectionIds: readonly string[];
  selectedRequestId: string | null;
  busy: boolean;
  canEdit: boolean;
  mobileOpen: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  createWorkspace: [name: string];
  selectWorkspace: [workspaceId: string | null];
  createCollection: [name: string, parentCollectionId: string | null];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  retryCollection: [collectionId: string];
  createRequest: [parentCollectionId: string];
  editCollectionProperties: [collectionId: string];
  editWorkspaceProperties: [workspaceId: string];
  import: [];
  selectRequest: [requestId: string];
  duplicateRequest: [requestId: string, name: string];
  deleteRequest: [requestId: string];
  reorderTree: [
    parentCollectionId: string | null,
    orderedNodeIds: readonly string[],
    expectedOrderRevision: number,
  ];
  moveTree: [
    nodeId: string,
    targetNodeId: string,
    placement: TreeDropPlacement,
    expectedSourceOrderRevision: number,
  ];
  dismiss: [];
}>();

const navigator = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
const creationKind = ref<CreationKind | null>(null);
const creationParentCollectionId = ref<string | null>(null);
const workspaceOptions = computed(() => [
  {
    value: NO_WORKSPACE_VALUE,
    label: t("workspace.none"),
    disabled: props.selectedWorkspaceId === null,
  },
  ...props.workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.name,
  })),
]);

/** Maps the menu's explicit empty option back to application selection state. */
function selectWorkspace(value: string): void {
  emit("selectWorkspace", value === NO_WORKSPACE_VALUE ? null : value);
}

/** Opens properties for the selected workspace when one is available. */
function editSelectedWorkspaceProperties(): void {
  if (props.selectedWorkspaceId !== null) {
    emit("editWorkspaceProperties", props.selectedWorkspaceId);
  }
}

const creationParentName = computed(() =>
  creationParentCollectionId.value === null
    ? null
    : findLoadedNodeName(creationParentCollectionId.value),
);
const creationContext = computed(() =>
  creationParentName.value === null
    ? null
    : t("collection.inside", { name: creationParentName.value }),
);
const focusableNodeId = computed(
  () =>
    props.selectedRequestId ??
    props.selectedCollectionId ??
    props.rootNodes[0]?.nodeId ??
    null,
);
const treeNavigation = useTreeNavigation();
const draggedNodeId = ref<string | null>(null);
const draggedParentCollectionId = ref<string | null>(null);
const draggedNodeKind = ref<TreeNodeKind | null>(null);
const dragging = ref(false);
const dropTargetNodeId = ref<string | null>(null);
const dropPlacement = ref<TreeDropPlacement | null>(null);
const reorderAnnouncement = ref("");

/** Returns the currently loaded children for one reorder boundary. */
function reorderSiblings(
  parentCollectionId: string | null,
): readonly TreeNode[] {
  return parentCollectionId === null
    ? props.rootNodes
    : (props.collectionChildren[parentCollectionId]?.children ?? []);
}

/** Returns the shared optimistic revision for a loaded sibling list. */
function siblingOrderRevision(siblings: readonly TreeNode[]): number {
  return siblings.reduce(
    (revision, sibling) => Math.max(revision, sibling.orderRevision),
    0,
  );
}

/** Emits a complete sibling order and announces the requested move. */
function emitReorder(
  nodeId: string,
  parentCollectionId: string | null,
  orderedNodeIds: readonly string[],
): void {
  const siblings = reorderSiblings(parentCollectionId);
  const node = siblings.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined || siblings.length < 2) return;
  const expectedOrderRevision = siblingOrderRevision(siblings);
  reorderAnnouncement.value = t("workspace.reorderRequested", {
    name: node.name,
    position: orderedNodeIds.indexOf(nodeId) + 1,
  });
  emit(
    "reorderTree",
    parentCollectionId,
    orderedNodeIds,
    expectedOrderRevision,
  );
}

/** Emits a cross-level move relative to a visible destination node. */
function emitMove(
  nodeId: string,
  sourceParentCollectionId: string | null,
  targetNodeId: string,
  placement: TreeDropPlacement,
): void {
  const siblings = reorderSiblings(sourceParentCollectionId);
  const node = siblings.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) return;
  reorderAnnouncement.value = t("workspace.moveRequested", {
    name: node.name,
  });
  emit(
    "moveTree",
    nodeId,
    targetNodeId,
    placement,
    siblingOrderRevision(siblings),
  );
}

/** Clears all transient native drag state. */
function cancelDrag(): void {
  draggedNodeId.value = null;
  draggedParentCollectionId.value = null;
  draggedNodeKind.value = null;
  dragging.value = false;
  dropTargetNodeId.value = null;
  dropPlacement.value = null;
}

/** Starts a native drag operation for one tree row. */
function startDrag(
  event: DragEvent,
  nodeId: string,
  parentCollectionId: string | null,
  nodeKind: TreeNodeKind,
): void {
  if (props.busy || !props.canEdit) {
    event.preventDefault();
    return;
  }
  dragging.value = true;
  draggedNodeId.value = nodeId;
  draggedParentCollectionId.value = parentCollectionId;
  draggedNodeKind.value = nodeKind;
  event.dataTransfer?.setData("text/plain", nodeId);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
}

/** Returns whether a destination parent is within the dragged collection. */
function wouldCreateLoadedCycle(
  destinationParentCollectionId: string | null,
): boolean {
  const movingNodeId = draggedNodeId.value;
  if (draggedNodeKind.value !== "collection" || movingNodeId === null) {
    return false;
  }
  let ancestorId = destinationParentCollectionId;
  const visited = new Set<string>();
  while (ancestorId !== null && !visited.has(ancestorId)) {
    if (ancestorId === movingNodeId) return true;
    visited.add(ancestorId);
    ancestorId = findLoadedParentCollectionId(ancestorId);
  }
  return false;
}

/** Tracks a before, inside, or after destination for the current drag. */
function updateDropTarget(
  event: DragEvent,
  nodeId: string,
  parentCollectionId: string | null,
  nodeKind: TreeNodeKind,
): void {
  if (!dragging.value) {
    return;
  }
  if (draggedNodeId.value === nodeId) {
    dropTargetNodeId.value = null;
    dropPlacement.value = null;
    return;
  }
  const row = event.currentTarget;
  if (!(row instanceof HTMLElement)) return;
  const bounds = row.getBoundingClientRect();
  const relativePosition =
    bounds.height === 0 ? 0.5 : (event.clientY - bounds.top) / bounds.height;
  const placement: TreeDropPlacement =
    nodeKind === "collection" &&
    relativePosition >= 0.4 &&
    relativePosition <= 0.6
      ? "inside"
      : relativePosition < 0.5
        ? "before"
        : "after";
  const destinationParentCollectionId =
    placement === "inside" ? nodeId : parentCollectionId;
  if (wouldCreateLoadedCycle(destinationParentCollectionId)) {
    dropTargetNodeId.value = null;
    dropPlacement.value = null;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
  dropTargetNodeId.value = nodeId;
  dropPlacement.value = placement;
}

/** Completes a valid drop as a sibling reorder or cross-level move. */
function finishDrop(
  event: DragEvent,
  nodeId: string,
  parentCollectionId: string | null,
  nodeKind: TreeNodeKind,
): void {
  updateDropTarget(event, nodeId, parentCollectionId, nodeKind);
  const movedNodeId = draggedNodeId.value;
  const sourceParentCollectionId = draggedParentCollectionId.value;
  const placement = dropPlacement.value;
  if (movedNodeId === null || placement === null) {
    cancelDrag();
    return;
  }
  event.preventDefault();
  const destinationParentCollectionId =
    placement === "inside" ? nodeId : parentCollectionId;
  if (sourceParentCollectionId !== destinationParentCollectionId) {
    emitMove(movedNodeId, sourceParentCollectionId, nodeId, placement);
    cancelDrag();
    return;
  }

  const remaining = reorderSiblings(sourceParentCollectionId)
    .map((node) => node.nodeId)
    .filter((candidate) => candidate !== movedNodeId);
  const targetPosition =
    placement === "inside" ? remaining.length : remaining.indexOf(nodeId);
  if (targetPosition < 0) {
    cancelDrag();
    return;
  }
  remaining.splice(
    targetPosition + (placement === "after" ? 1 : 0),
    0,
    movedNodeId,
  );
  emitReorder(movedNodeId, sourceParentCollectionId, remaining);
  cancelDrag();
}

/** Moves a focused row by one sibling for keyboard and mobile accessibility. */
function moveByKeyboard(
  nodeId: string,
  parentCollectionId: string | null,
  offset: -1 | 1,
): void {
  if (props.busy || !props.canEdit) return;
  const orderedNodeIds = reorderSiblings(parentCollectionId).map(
    (node) => node.nodeId,
  );
  const position = orderedNodeIds.indexOf(nodeId);
  const destination = position + offset;
  if (position < 0 || destination < 0 || destination >= orderedNodeIds.length) {
    return;
  }
  [orderedNodeIds[position], orderedNodeIds[destination]] = [
    orderedNodeIds[destination]!,
    orderedNodeIds[position]!,
  ];
  emitReorder(nodeId, parentCollectionId, orderedNodeIds);
}

/** Indents a row into the preceding sibling collection. */
function indentByKeyboard(
  nodeId: string,
  parentCollectionId: string | null,
): void {
  if (props.busy || !props.canEdit) return;
  const siblings = reorderSiblings(parentCollectionId);
  const position = siblings.findIndex((node) => node.nodeId === nodeId);
  const precedingNode = siblings[position - 1];
  if (precedingNode?.kind !== "collection") return;
  emitMove(nodeId, parentCollectionId, precedingNode.nodeId, "inside");
}

/** Outdents a row to immediately after its current parent collection. */
function outdentByKeyboard(
  nodeId: string,
  parentCollectionId: string | null,
): void {
  if (props.busy || !props.canEdit || parentCollectionId === null) return;
  emitMove(nodeId, parentCollectionId, parentCollectionId, "after");
}

provide(workspaceTreeReorderKey, {
  draggedNodeId,
  dropTargetNodeId,
  dropPlacement,
  startDrag,
  updateDropTarget,
  finishDrop,
  cancelDrag,
  moveByKeyboard,
  indentByKeyboard,
  outdentByKeyboard,
});

watch(
  () => props.mobileOpen,
  async (open) => {
    if (open) {
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      await nextTick();
      const initialFocus = focusableElements()[0] ?? navigator.value;
      initialFocus?.focus();
    } else {
      returnFocus?.focus();
      returnFocus = null;
    }
  },
);

onBeforeUnmount(() => returnFocus?.focus());

/** Returns enabled focus targets owned by the modal mobile navigator. */
function focusableElements(): HTMLElement[] {
  return [
    ...(navigator.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []),
  ];
}

/** Contains keyboard focus and handles expected mobile modal dismissal. */
function handleNavigatorKeydown(event: KeyboardEvent): void {
  if (!props.mobileOpen) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    emit("dismiss");
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableElements();
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    navigator.value?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Opens the creation dialog for one navigator resource type. */
function openCreationDialog(
  kind: CreationKind,
  parentCollectionId: string | null = null,
): void {
  creationKind.value = kind;
  creationParentCollectionId.value = parentCollectionId;
}

/** Clears the active creation mode after the modal closes. */
function closeCreationDialog(): void {
  creationKind.value = null;
  creationParentCollectionId.value = null;
}

/** Routes normalized modal fields to the existing creation events. */
function submitCreation(name: string): void {
  if (creationKind.value === "workspace") {
    emit("createWorkspace", name);
  } else if (creationKind.value === "collection") {
    emit("createCollection", name, creationParentCollectionId.value);
  }
}

/** Forwards a request duplication with the source name used for localization. */
function duplicateRequest(requestId: string, name: string): void {
  emit("duplicateRequest", requestId, name);
}

/** Finds a loaded collection name for creation-dialog context. */
function findLoadedNodeName(nodeId: string): string | null {
  const groups = [
    props.rootNodes,
    ...Object.values(props.collectionChildren).map((state) => state.children),
  ];
  for (const group of groups) {
    const match = group.find((node) => node.nodeId === nodeId);
    if (match !== undefined) {
      return match.name;
    }
  }
  return null;
}

/** Finds the parent boundary for a node already represented in the tree. */
function findLoadedParentCollectionId(nodeId: string): string | null {
  if (props.rootNodes.some((node) => node.nodeId === nodeId)) return null;
  for (const [parentCollectionId, state] of Object.entries(
    props.collectionChildren,
  )) {
    if (state.children.some((node) => node.nodeId === nodeId)) {
      return parentCollectionId;
    }
  }
  return null;
}
</script>

<template>
  <aside
    ref="navigator"
    class="workspace-navigator"
    :class="{ 'is-mobile-open': mobileOpen }"
    :role="mobileOpen ? 'dialog' : undefined"
    :aria-modal="mobileOpen ? 'true' : undefined"
    :aria-label="t('workspace.navigation')"
    :tabindex="mobileOpen ? -1 : undefined"
    @keydown="handleNavigatorKeydown"
  >
    <div class="navigator-section">
      <label class="navigator-heading" for="workspace-select">
        {{ t("workspace.label") }}
      </label>
      <div class="workspace-select-row">
        <SelectMenu
          input-id="workspace-select"
          class="workspace-picker"
          :model-value="selectedWorkspaceId ?? ''"
          :options="workspaceOptions"
          :label="t('workspace.label')"
          :placeholder="t('workspace.select')"
          :disabled="busy"
          @update:model-value="selectWorkspace"
        />
        <IconButton
          :label="t('workspace.properties')"
          :disabled="busy || selectedWorkspaceId === null"
          @click="editSelectedWorkspaceProperties"
        >
          <Settings2 :size="17" aria-hidden="true" />
        </IconButton>
        <IconButton
          :label="t('workspace.create')"
          :disabled="busy"
          @click="openCreationDialog('workspace')"
        >
          <Plus :size="17" aria-hidden="true" />
        </IconButton>
      </div>
    </div>

    <div v-if="selectedWorkspaceId" class="navigator-section navigator-grow">
      <div class="section-heading">
        <span class="navigator-heading">{{ t("workspace.collections") }}</span>
        <div class="section-actions">
          <IconButton
            class="compact-icon-button"
            size="compact"
            :label="t('import.action')"
            :disabled="busy || !canEdit"
            @click="emit('import')"
          >
            <FileUp :size="16" aria-hidden="true" />
          </IconButton>
          <IconButton
            class="compact-icon-button"
            size="compact"
            :label="t('workspace.createRootCollection')"
            :disabled="busy || !canEdit"
            @click="openCreationDialog('collection')"
          >
            <FolderPlus :size="16" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <nav class="workspace-tree" :aria-label="t('workspace.tree')">
        <p class="visually-hidden" aria-live="polite">
          {{ reorderAnnouncement }}
        </p>
        <ul
          v-if="rootNodes.length > 0"
          class="workspace-tree-root"
          role="tree"
          :aria-label="t('workspace.tree')"
          @focusin="treeNavigation.handleFocusIn"
          @keydown="treeNavigation.handleKeydown"
        >
          <WorkspaceTreeNode
            v-for="node in rootNodes"
            :key="node.nodeId"
            :node="node"
            :collection-children="collectionChildren"
            :expanded-collection-ids="expandedCollectionIds"
            :selected-collection-id="selectedCollectionId"
            :selected-request-id="selectedRequestId"
            :busy="busy"
            :can-edit="canEdit"
            :focusable-node-id="focusableNodeId"
            :parent-node-id="null"
            :level="1"
            @create-collection="openCreationDialog('collection', $event)"
            @create-request="emit('createRequest', $event)"
            @edit-collection-properties="
              emit('editCollectionProperties', $event)
            "
            @select-collection="emit('selectCollection', $event)"
            @toggle-collection="emit('toggleCollection', $event)"
            @retry-collection="emit('retryCollection', $event)"
            @select-request="emit('selectRequest', $event)"
            @duplicate-request="duplicateRequest"
            @delete-request="emit('deleteRequest', $event)"
          />
        </ul>
        <p v-else class="tree-empty">{{ t("workspace.noCollections") }}</p>
      </nav>
    </div>

    <CreateResourceDialog
      v-if="creationKind !== null"
      :kind="creationKind"
      :busy="busy"
      :context="creationContext"
      @close="closeCreationDialog"
      @submit="submitCreation"
    />
  </aside>
</template>
