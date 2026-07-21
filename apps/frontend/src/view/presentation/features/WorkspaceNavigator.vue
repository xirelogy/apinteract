<script setup lang="ts">
import { computed, ref } from "vue";
import { FilePlus, FolderPlus, Plus } from "@lucide/vue";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";
import CreateResourceDialog from "./CreateResourceDialog.vue";
import WorkspaceTreeNode from "./WorkspaceTreeNode.vue";

type CreationKind = "workspace" | "collection" | "request";

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

const emit = defineEmits<{
  createWorkspace: [name: string];
  selectWorkspace: [workspaceId: string];
  createCollection: [name: string, parentCollectionId: string | null];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  createRequest: [name: string, targetUrl: string];
  selectRequest: [requestId: string];
}>();

const creationKind = ref<CreationKind | null>(null);
const creationParentCollectionId = ref<string | null>(null);
const creationParentName = computed(() =>
  creationParentCollectionId.value === null
    ? null
    : findLoadedNodeName(creationParentCollectionId.value),
);
const creationContext = computed(() =>
  creationParentName.value === null
    ? null
    : `Inside ${creationParentName.value}`,
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
function submitCreation(name: string, targetUrl: string | null): void {
  if (creationKind.value === "workspace") {
    emit("createWorkspace", name);
  } else if (creationKind.value === "collection") {
    emit("createCollection", name, creationParentCollectionId.value);
  } else if (creationKind.value === "request" && targetUrl !== null) {
    emit("createRequest", name, targetUrl);
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
  <aside class="workspace-navigator" aria-label="Workspace navigation">
    <div class="navigator-section">
      <label class="field-label" for="workspace-select">Workspace</label>
      <div class="workspace-select-row">
        <select
          id="workspace-select"
          class="select-input"
          :value="selectedWorkspaceId ?? ''"
          :disabled="busy"
          @change="
            emit('selectWorkspace', ($event.target as HTMLSelectElement).value)
          "
        >
          <option value="" disabled>Select a workspace</option>
          <option
            v-for="workspace in workspaces"
            :key="workspace.workspaceId"
            :value="workspace.workspaceId"
          >
            {{ workspace.name }}
          </option>
        </select>
        <button
          class="icon-button"
          type="button"
          title="Create workspace"
          aria-label="Create workspace"
          :disabled="busy"
          @click="openCreationDialog('workspace')"
        >
          <Plus :size="17" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="selectedWorkspaceId" class="navigator-section navigator-grow">
      <div class="section-heading">
        <span>Collections</span>
        <div class="section-actions">
          <button
            class="icon-button compact-icon-button"
            type="button"
            title="Create root collection"
            aria-label="Create root collection"
            :disabled="busy"
            @click="openCreationDialog('collection')"
          >
            <FolderPlus :size="16" aria-hidden="true" />
          </button>
          <button
            class="icon-button compact-icon-button"
            type="button"
            title="Create request"
            aria-label="Create request"
            :disabled="busy || selectedCollectionId === null"
            @click="openCreationDialog('request', selectedCollectionId)"
          >
            <FilePlus :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>
      <nav class="workspace-tree" aria-label="Workspace tree">
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
        <p v-else class="tree-empty">No collections yet</p>
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
