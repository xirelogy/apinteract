<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, Folder, FolderOpen } from "@lucide/vue";

import type { TreeNode } from "@/model/contracts/backend";

const props = defineProps<{
  node: TreeNode;
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  expandedCollectionIds: readonly string[];
  selectedCollectionId: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  select: [collectionId: string];
  toggle: [collectionId: string];
}>();

const expanded = computed(() =>
  props.expandedCollectionIds.includes(props.node.nodeId),
);
const children = computed(() =>
  (props.collectionChildren[props.node.nodeId] ?? []).filter(
    (node) => node.kind === "collection",
  ),
);
</script>

<template>
  <li class="workspace-tree-node" role="treeitem" :aria-expanded="expanded">
    <div
      class="workspace-tree-row collection-picker-row"
      :class="{ 'is-selected': node.nodeId === selectedCollectionId }"
    >
      <button
        class="tree-toggle-button"
        type="button"
        :title="expanded ? `Collapse ${node.name}` : `Expand ${node.name}`"
        :aria-label="expanded ? `Collapse ${node.name}` : `Expand ${node.name}`"
        :disabled="busy"
        @click="emit('toggle', node.nodeId)"
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
        @click="emit('select', node.nodeId)"
      >
        <FolderOpen v-if="expanded" :size="16" aria-hidden="true" />
        <Folder v-else :size="16" aria-hidden="true" />
        <span>{{ node.name }}</span>
      </button>
    </div>

    <ul
      v-if="expanded && children.length > 0"
      class="workspace-tree-children"
      role="group"
    >
      <CollectionPickerTreeNode
        v-for="child in children"
        :key="child.nodeId"
        :node="child"
        :collection-children="collectionChildren"
        :expanded-collection-ids="expandedCollectionIds"
        :selected-collection-id="selectedCollectionId"
        :busy="busy"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </li>
</template>
