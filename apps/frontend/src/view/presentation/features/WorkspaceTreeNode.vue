<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, Folder, FolderOpen, FolderPlus } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode } from "@/model/contracts/backend";

const props = defineProps<{
  node: TreeNode;
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  expandedCollectionIds: readonly string[];
  selectedCollectionId: string | null;
  selectedRequestId: string | null;
  busy: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  createCollection: [parentCollectionId: string];
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
        :disabled="busy"
        @click="emit('selectCollection', node.nodeId)"
      >
        <FolderOpen v-if="expanded" :size="16" aria-hidden="true" />
        <Folder v-else :size="16" aria-hidden="true" />
        <span>{{ node.name }}</span>
      </button>
      <button
        class="tree-node-action"
        type="button"
        :title="t('collection.createSubcollection', { name: node.name })"
        :aria-label="t('collection.createSubcollection', { name: node.name })"
        :disabled="busy"
        @click="emit('createCollection', node.nodeId)"
      >
        <FolderPlus :size="15" aria-hidden="true" />
      </button>
    </div>

    <button
      v-else
      class="workspace-tree-row request-tree-row"
      :class="{ 'is-selected': node.nodeId === selectedRequestId }"
      type="button"
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
        @create-collection="emit('createCollection', $event)"
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
