<script setup lang="ts">
import { computed, ref } from "vue";
import { FilePlus, FolderPlus, Plus } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import CreateResourceDialog from "./CreateResourceDialog.vue";
import WorkspaceTreeNode from "./WorkspaceTreeNode.vue";

type CreationKind = "workspace" | "collection";

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  rootNodes: readonly TreeNode[];
  selectedCollectionId: string | null;
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  expandedCollectionIds: readonly string[];
  selectedRequestId: string | null;
  busy: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  createWorkspace: [name: string];
  selectWorkspace: [workspaceId: string];
  createCollection: [name: string, parentCollectionId: string | null];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  createRequest: [parentCollectionId: string | null];
  selectRequest: [requestId: string];
}>();

const creationKind = ref<CreationKind | null>(null);
const creationParentCollectionId = ref<string | null>(null);
const workspaceOptions = computed(() =>
  props.workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.name,
  })),
);
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

/** Finds a loaded collection name for creation-dialog context. */
function findLoadedNodeName(nodeId: string): string | null {
  const groups = [props.rootNodes, ...Object.values(props.collectionChildren)];
  for (const group of groups) {
    const match = group.find((node) => node.nodeId === nodeId);
    if (match !== undefined) {
      return match.name;
    }
  }
  return null;
}
</script>

<template>
  <aside class="workspace-navigator" :aria-label="t('workspace.navigation')">
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
          @update:model-value="emit('selectWorkspace', $event)"
        />
        <button
          class="icon-button"
          type="button"
          :title="t('workspace.create')"
          :aria-label="t('workspace.create')"
          :disabled="busy"
          @click="openCreationDialog('workspace')"
        >
          <Plus :size="17" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="selectedWorkspaceId" class="navigator-section navigator-grow">
      <div class="section-heading">
        <span class="navigator-heading">{{ t("workspace.collections") }}</span>
        <div class="section-actions">
          <button
            class="icon-button compact-icon-button"
            type="button"
            :title="t('workspace.createRootCollection')"
            :aria-label="t('workspace.createRootCollection')"
            :disabled="busy"
            @click="openCreationDialog('collection')"
          >
            <FolderPlus :size="16" aria-hidden="true" />
          </button>
          <button
            class="icon-button compact-icon-button"
            type="button"
            :title="t('workspace.createRequest')"
            :aria-label="t('workspace.createRequest')"
            :disabled="busy || selectedCollectionId === null"
            @click="emit('createRequest', selectedCollectionId)"
          >
            <FilePlus :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>
      <nav class="workspace-tree" :aria-label="t('workspace.tree')">
        <ul v-if="rootNodes.length > 0" class="workspace-tree-root">
          <WorkspaceTreeNode
            v-for="node in rootNodes"
            :key="node.nodeId"
            :node="node"
            :collection-children="collectionChildren"
            :expanded-collection-ids="expandedCollectionIds"
            :selected-collection-id="selectedCollectionId"
            :selected-request-id="selectedRequestId"
            :busy="busy"
            @create-collection="openCreationDialog('collection', $event)"
            @select-collection="emit('selectCollection', $event)"
            @toggle-collection="emit('toggleCollection', $event)"
            @select-request="emit('selectRequest', $event)"
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
