<script setup lang="ts">
import { computed, inject } from "vue";
import {
  ChevronRight,
  Copy,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  LoaderCircle,
  Settings2,
  Trash2,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode } from "@/model/contracts/backend";
import type { CollectionChildrenState } from "@/model/domain/application";
import ActionMenu, {
  type ActionMenuItem,
} from "@/view/presentation/controls/ActionMenu.vue";
import { workspaceTreeReorderKey } from "./workspace-tree-reorder";

const props = defineProps<{
  node: TreeNode;
  collectionChildren: Readonly<Record<string, CollectionChildrenState>>;
  expandedCollectionIds: readonly string[];
  selectedCollectionId: string | null;
  selectedRequestId: string | null;
  busy: boolean;
  canEdit: boolean;
  focusableNodeId: string | null;
  parentNodeId: string | null;
  level: number;
}>();
const { t } = useI18n();
const injectedTreeReorder = inject(workspaceTreeReorderKey);
if (injectedTreeReorder === undefined) {
  throw new Error("WorkspaceTreeNode requires a tree reorder context.");
}
const treeReorder = injectedTreeReorder;

const emit = defineEmits<{
  createCollection: [parentCollectionId: string];
  createRequest: [parentCollectionId: string];
  editCollectionProperties: [collectionId: string];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  retryCollection: [collectionId: string];
  selectRequest: [requestId: string];
  duplicateRequest: [requestId: string, name: string];
  deleteRequest: [requestId: string];
}>();

const expanded = computed(
  () =>
    props.node.kind === "collection" &&
    props.expandedCollectionIds.includes(props.node.nodeId),
);
const childState = computed(() => props.collectionChildren[props.node.nodeId]);
const children = computed(() => childState.value?.children ?? []);
const collectionActions = computed<readonly ActionMenuItem[]>(() => [
  {
    value: "create-request",
    label: t("collection.newRequest"),
    disabled: !props.canEdit,
  },
  {
    value: "create-subcollection",
    label: t("collection.newSubcollection"),
    disabled: !props.canEdit,
  },
  {
    value: "edit-properties",
    label: t("collection.properties"),
  },
]);
const requestActions = computed<readonly ActionMenuItem[]>(() => [
  {
    value: "duplicate",
    label: t("request.duplicateAction"),
  },
  {
    value: "delete",
    label: t("request.deleteAction"),
    variant: "danger",
  },
]);

/** Routes a row-local collection command to its domain-specific event. */
function selectCollectionAction(value: string): void {
  if (value === "create-request") {
    emit("createRequest", props.node.nodeId);
  } else if (value === "create-subcollection") {
    emit("createCollection", props.node.nodeId);
  } else if (value === "edit-properties") {
    emit("editCollectionProperties", props.node.nodeId);
  }
}

/** Routes one request-row command without changing the current selection. */
function selectRequestAction(value: string): void {
  if (value === "duplicate") {
    emit("duplicateRequest", props.node.nodeId, props.node.name);
  } else if (value === "delete") {
    emit("deleteRequest", props.node.nodeId);
  }
}

/** Forwards a nested request duplication without dropping its display name. */
function forwardRequestDuplication(requestId: string, name: string): void {
  emit("duplicateRequest", requestId, name);
}

/** Returns drag-state classes for this row's insertion indicator. */
function reorderClasses(): Record<string, boolean> {
  return {
    "is-dragging": treeReorder.draggedNodeId.value === props.node.nodeId,
    "is-drop-before":
      treeReorder.dropTargetNodeId.value === props.node.nodeId &&
      treeReorder.dropPlacement.value === "before",
    "is-drop-after":
      treeReorder.dropTargetNodeId.value === props.node.nodeId &&
      treeReorder.dropPlacement.value === "after",
    "is-drop-inside":
      treeReorder.dropTargetNodeId.value === props.node.nodeId &&
      treeReorder.dropPlacement.value === "inside",
  };
}

/** Applies the keyboard reorder alternative without affecting tree navigation. */
function handleTreeItemKeydown(event: KeyboardEvent): void {
  if (
    !event.altKey ||
    !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "ArrowLeft") {
    treeReorder.outdentByKeyboard(props.node.nodeId, props.parentNodeId);
  } else if (event.key === "ArrowRight") {
    treeReorder.indentByKeyboard(props.node.nodeId, props.parentNodeId);
  } else {
    treeReorder.moveByKeyboard(
      props.node.nodeId,
      props.parentNodeId,
      event.key === "ArrowUp" ? -1 : 1,
    );
  }
}
</script>

<template>
  <li class="workspace-tree-node">
    <div
      v-if="node.kind === 'collection'"
      class="workspace-tree-row collection-tree-row"
      :class="[
        { 'is-selected': node.nodeId === selectedCollectionId },
        reorderClasses(),
      ]"
      @dragover.stop="
        treeReorder.updateDropTarget(
          $event,
          node.nodeId,
          parentNodeId,
          node.kind,
        )
      "
      @drop.stop="
        treeReorder.finishDrop($event, node.nodeId, parentNodeId, node.kind)
      "
    >
      <button
        class="tree-toggle-button"
        type="button"
        tabindex="-1"
        :title="
          expanded
            ? t('collection.collapse', { name: node.name })
            : t('collection.expand', { name: node.name })
        "
        :aria-label="
          expanded
            ? t('collection.collapse', { name: node.name })
            : t('collection.expand', { name: node.name })
        "
        :aria-expanded="expanded"
        :disabled="busy"
        @click="emit('toggleCollection', node.nodeId)"
      >
        <ChevronRight
          class="tree-chevron"
          :class="{ 'is-expanded': expanded }"
          :size="15"
          aria-hidden="true"
        />
      </button>
      <button
        class="tree-node-main"
        type="button"
        role="treeitem"
        :aria-level="level"
        :aria-expanded="expanded"
        :aria-selected="node.nodeId === selectedCollectionId"
        :tabindex="node.nodeId === focusableNodeId ? 0 : -1"
        :data-tree-node-id="node.nodeId"
        :data-tree-parent-id="parentNodeId ?? undefined"
        :data-tree-text="node.name"
        :draggable="!busy && canEdit"
        :disabled="busy"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
        :title="t('workspace.reorderHint')"
        @click="emit('editCollectionProperties', node.nodeId)"
        @keydown="handleTreeItemKeydown"
        @dragstart="
          treeReorder.startDrag($event, node.nodeId, parentNodeId, node.kind)
        "
        @dragend="treeReorder.cancelDrag"
      >
        <GripVertical
          class="tree-drag-indicator"
          :size="14"
          aria-hidden="true"
        />
        <FolderOpen v-if="expanded" :size="16" aria-hidden="true" />
        <Folder v-else :size="16" aria-hidden="true" />
        <span>{{ node.name }}</span>
      </button>
      <ActionMenu
        class="tree-node-action-menu"
        :label="t('collection.moreActions', { name: node.name })"
        :items="collectionActions"
        :disabled="busy"
        @select="selectCollectionAction"
      >
        <template #item="{ item }">
          <FilePlus
            v-if="item.value === 'create-request'"
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <FolderPlus
            v-else-if="item.value === 'create-subcollection'"
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <Settings2
            v-else
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <span>{{ item.label }}</span>
        </template>
      </ActionMenu>
    </div>

    <div
      v-else
      class="workspace-tree-row request-tree-row"
      :class="[
        { 'is-selected': node.nodeId === selectedRequestId },
        reorderClasses(),
      ]"
      @dragover.stop="
        treeReorder.updateDropTarget(
          $event,
          node.nodeId,
          parentNodeId,
          node.kind,
        )
      "
      @drop.stop="
        treeReorder.finishDrop($event, node.nodeId, parentNodeId, node.kind)
      "
    >
      <span class="tree-toggle-spacer" aria-hidden="true"></span>
      <button
        class="tree-node-main request-tree-main"
        type="button"
        role="treeitem"
        :aria-level="level"
        :aria-selected="node.nodeId === selectedRequestId"
        :tabindex="node.nodeId === focusableNodeId ? 0 : -1"
        :data-tree-node-id="node.nodeId"
        :data-tree-parent-id="parentNodeId ?? undefined"
        :data-tree-text="node.name"
        :draggable="!busy && canEdit"
        :disabled="busy"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
        :title="t('workspace.reorderHint')"
        @click="emit('selectRequest', node.nodeId)"
        @keydown="handleTreeItemKeydown"
        @dragstart="
          treeReorder.startDrag($event, node.nodeId, parentNodeId, node.kind)
        "
        @dragend="treeReorder.cancelDrag"
      >
        <span class="request-tree-label">
          <GripVertical
            class="tree-drag-indicator"
            :size="14"
            aria-hidden="true"
          />
          <span class="method-badge">{{ node.method ?? "GET" }}</span>
          <span class="tree-node-name">{{ node.name }}</span>
        </span>
      </button>
      <ActionMenu
        class="tree-node-action-menu"
        :label="t('request.moreActions', { name: node.name })"
        :items="requestActions"
        :disabled="busy || !canEdit"
        @select="selectRequestAction"
      >
        <template #item="{ item }">
          <Copy
            v-if="item.value === 'duplicate'"
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <Trash2
            v-else
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <span>{{ item.label }}</span>
        </template>
      </ActionMenu>
    </div>

    <ul
      v-if="node.kind === 'collection' && expanded"
      class="workspace-tree-children"
      role="group"
      :aria-busy="childState?.status === 'loading'"
    >
      <WorkspaceTreeNode
        v-for="child in children"
        :key="child.nodeId"
        :node="child"
        :collection-children="collectionChildren"
        :expanded-collection-ids="expandedCollectionIds"
        :selected-collection-id="selectedCollectionId"
        :selected-request-id="selectedRequestId"
        :busy="busy"
        :can-edit="canEdit"
        :focusable-node-id="focusableNodeId"
        :parent-node-id="node.nodeId"
        :level="level + 1"
        @create-collection="emit('createCollection', $event)"
        @create-request="emit('createRequest', $event)"
        @edit-collection-properties="emit('editCollectionProperties', $event)"
        @select-collection="emit('selectCollection', $event)"
        @toggle-collection="emit('toggleCollection', $event)"
        @retry-collection="emit('retryCollection', $event)"
        @select-request="emit('selectRequest', $event)"
        @duplicate-request="forwardRequestDuplication"
        @delete-request="emit('deleteRequest', $event)"
      />
      <li
        v-if="childState?.status === 'loading'"
        class="tree-empty tree-branch-status"
        role="status"
      >
        <LoaderCircle
          class="tree-status-spinner"
          :size="13"
          aria-hidden="true"
        />
        {{
          children.length === 0
            ? t("collection.loading")
            : t("collection.refreshing")
        }}
      </li>
      <li
        v-else-if="childState?.status === 'error'"
        class="tree-empty tree-branch-status"
      >
        <span>{{ t("collection.loadFailed") }}</span>
        <button
          type="button"
          class="tree-branch-retry"
          @click="emit('retryCollection', node.nodeId)"
        >
          {{ t("collection.retry") }}
        </button>
      </li>
      <li
        v-else-if="childState?.status === 'ready' && children.length === 0"
        class="tree-empty"
      >
        {{ t("collection.empty") }}
      </li>
    </ul>
  </li>
</template>
