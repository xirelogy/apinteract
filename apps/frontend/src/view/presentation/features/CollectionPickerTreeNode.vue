<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode } from "@/model/contracts/backend";
import type { CollectionChildrenState } from "@/model/domain/application";

const props = defineProps<{
  node: TreeNode;
  collectionChildren: Readonly<Record<string, CollectionChildrenState>>;
  expandedCollectionIds: readonly string[];
  selectedCollectionId: string;
  busy: boolean;
  parentNodeId: string | null;
  level: number;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  select: [collectionId: string];
  toggle: [collectionId: string];
  retry: [collectionId: string];
}>();

const expanded = computed(() =>
  props.expandedCollectionIds.includes(props.node.nodeId),
);
const childState = computed(() => props.collectionChildren[props.node.nodeId]);
const children = computed(() =>
  (childState.value?.children ?? []).filter(
    (node) => node.kind === "collection",
  ),
);
</script>

<template>
  <li class="workspace-tree-node">
    <div
      class="workspace-tree-row collection-picker-row"
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
        role="treeitem"
        :aria-level="level"
        :aria-expanded="expanded"
        :aria-selected="node.nodeId === selectedCollectionId"
        :tabindex="node.nodeId === selectedCollectionId ? 0 : -1"
        :data-tree-node-id="node.nodeId"
        :data-tree-parent-id="parentNodeId ?? undefined"
        :data-tree-text="node.name"
        :disabled="busy"
        @click="emit('select', node.nodeId)"
      >
        <FolderOpen v-if="expanded" :size="16" aria-hidden="true" />
        <Folder v-else :size="16" aria-hidden="true" />
        <span>{{ node.name }}</span>
      </button>
    </div>

    <ul
      v-if="expanded"
      class="workspace-tree-children"
      role="group"
      :aria-busy="childState?.status === 'loading'"
    >
      <CollectionPickerTreeNode
        v-for="child in children"
        :key="child.nodeId"
        :node="child"
        :collection-children="collectionChildren"
        :expanded-collection-ids="expandedCollectionIds"
        :selected-collection-id="selectedCollectionId"
        :busy="busy"
        :parent-node-id="node.nodeId"
        :level="level + 1"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @retry="emit('retry', $event)"
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
          @click="emit('retry', node.nodeId)"
        >
          {{ t("collection.retry") }}
        </button>
      </li>
    </ul>
  </li>
</template>
