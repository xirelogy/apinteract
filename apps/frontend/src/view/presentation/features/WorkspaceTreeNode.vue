<script setup lang="ts">
import { computed } from "vue";
import {
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Settings2,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode } from "@/model/contracts/backend";
import ActionMenu, {
  type ActionMenuItem,
} from "@/view/presentation/controls/ActionMenu.vue";

const props = defineProps<{
  node: TreeNode;
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  expandedCollectionIds: readonly string[];
  selectedCollectionId: string | null;
  selectedRequestId: string | null;
  busy: boolean;
  focusableNodeId: string | null;
  parentNodeId: string | null;
  level: number;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  createCollection: [parentCollectionId: string];
  createRequest: [parentCollectionId: string];
  editCollectionHeaders: [collectionId: string];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  selectRequest: [requestId: string];
}>();

const expanded = computed(
  () =>
    props.node.kind === "collection" &&
    props.expandedCollectionIds.includes(props.node.nodeId),
);
const children = computed(
  () => props.collectionChildren[props.node.nodeId] ?? [],
);
const collectionActions = computed<readonly ActionMenuItem[]>(() => [
  {
    value: "create-request",
    label: t("collection.newRequest"),
  },
  {
    value: "create-subcollection",
    label: t("collection.newSubcollection"),
  },
  {
    value: "edit-headers",
    label: t("collection.editHeadersShort"),
  },
]);

/** Routes a row-local collection command to its domain-specific event. */
function selectCollectionAction(value: string): void {
  if (value === "create-request") {
    emit("createRequest", props.node.nodeId);
  } else if (value === "create-subcollection") {
    emit("createCollection", props.node.nodeId);
  } else if (value === "edit-headers") {
    emit("editCollectionHeaders", props.node.nodeId);
  }
}
</script>

<template>
  <li class="workspace-tree-node">
    <div
      v-if="node.kind === 'collection'"
      class="workspace-tree-row collection-tree-row"
      :class="{ 'is-selected': node.nodeId === selectedCollectionId }"
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
        :disabled="busy"
        @click="emit('selectCollection', node.nodeId)"
      >
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

    <button
      v-else
      class="workspace-tree-row request-tree-row"
      :class="{ 'is-selected': node.nodeId === selectedRequestId }"
      type="button"
      role="treeitem"
      :aria-level="level"
      :aria-selected="node.nodeId === selectedRequestId"
      :tabindex="node.nodeId === focusableNodeId ? 0 : -1"
      :data-tree-node-id="node.nodeId"
      :data-tree-parent-id="parentNodeId ?? undefined"
      :data-tree-text="node.name"
      :disabled="busy"
      @click="emit('selectRequest', node.nodeId)"
    >
      <span class="tree-toggle-spacer" aria-hidden="true"></span>
      <span class="request-tree-label">
        <span class="method-badge">{{ node.method ?? "GET" }}</span>
        <span class="tree-node-name">{{ node.name }}</span>
      </span>
    </button>

    <ul
      v-if="node.kind === 'collection' && expanded"
      class="workspace-tree-children"
      role="group"
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
        :focusable-node-id="focusableNodeId"
        :parent-node-id="node.nodeId"
        :level="level + 1"
        @create-collection="emit('createCollection', $event)"
        @create-request="emit('createRequest', $event)"
        @edit-collection-headers="emit('editCollectionHeaders', $event)"
        @select-collection="emit('selectCollection', $event)"
        @toggle-collection="emit('toggleCollection', $event)"
        @select-request="emit('selectRequest', $event)"
      />
      <li v-if="children.length === 0" class="tree-empty">
        {{ t("collection.empty") }}
      </li>
    </ul>
  </li>
</template>
