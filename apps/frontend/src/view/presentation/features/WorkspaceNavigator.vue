<script setup lang="ts">
import { computed, ref } from "vue";
import { FilePlus, FolderPlus, Plus } from "@lucide/vue";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";
import CreateResourceDialog from "./CreateResourceDialog.vue";

type CreationKind = "workspace" | "collection" | "request";

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  rootNodes: readonly TreeNode[];
  selectedCollectionId: string | null;
  collectionNodes: readonly TreeNode[];
  busy: boolean;
}>();

const emit = defineEmits<{
  createWorkspace: [name: string];
  selectWorkspace: [workspaceId: string];
  createCollection: [name: string];
  selectCollection: [collectionId: string];
  createRequest: [name: string, targetUrl: string];
  selectRequest: [requestId: string];
}>();

const creationKind = ref<CreationKind | null>(null);

const collections = computed(() =>
  props.rootNodes.filter((node) => node.kind === "collection"),
);
const requests = computed(() =>
  props.collectionNodes.filter((node) => node.kind === "request"),
);

/** Opens the creation dialog for one navigator resource type. */
function openCreationDialog(kind: CreationKind): void {
  creationKind.value = kind;
}

/** Clears the active creation mode after the modal closes. */
function closeCreationDialog(): void {
  creationKind.value = null;
}

/** Routes normalized modal fields to the existing creation events. */
function submitCreation(name: string, targetUrl: string | null): void {
  if (creationKind.value === "workspace") {
    emit("createWorkspace", name);
  } else if (creationKind.value === "collection") {
    emit("createCollection", name);
  } else if (creationKind.value === "request" && targetUrl !== null) {
    emit("createRequest", name, targetUrl);
  }
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

    <div v-if="selectedWorkspaceId" class="navigator-section">
      <div class="section-heading">
        <span>Collections</span>
        <button
          class="icon-button compact-icon-button"
          type="button"
          title="Create collection"
          aria-label="Create collection"
          :disabled="busy"
          @click="openCreationDialog('collection')"
        >
          <FolderPlus :size="16" aria-hidden="true" />
        </button>
      </div>
      <nav class="tree-list" aria-label="Collections">
        <p v-if="collections.length === 0" class="tree-empty">
          No collections yet
        </p>
        <button
          v-for="collection in collections"
          :key="collection.nodeId"
          class="tree-item"
          :class="{ 'is-selected': collection.nodeId === selectedCollectionId }"
          type="button"
          @click="emit('selectCollection', collection.nodeId)"
        >
          {{ collection.name }}
        </button>
      </nav>
    </div>

    <div v-if="selectedCollectionId" class="navigator-section navigator-grow">
      <div class="section-heading">
        <span>Requests</span>
        <button
          class="icon-button compact-icon-button"
          type="button"
          title="Create request"
          aria-label="Create request"
          :disabled="busy"
          @click="openCreationDialog('request')"
        >
          <FilePlus :size="16" aria-hidden="true" />
        </button>
      </div>
      <nav class="tree-list" aria-label="Requests">
        <p v-if="requests.length === 0" class="tree-empty">No requests yet</p>
        <button
          v-for="request in requests"
          :key="request.nodeId"
          class="tree-item request-item"
          type="button"
          @click="emit('selectRequest', request.nodeId)"
        >
          <span class="method-badge">GET</span>
          <span>{{ request.name }}</span>
        </button>
      </nav>
    </div>

    <CreateResourceDialog
      v-if="creationKind !== null"
      :kind="creationKind"
      :busy="busy"
      @close="closeCreationDialog"
      @submit="submitCreation"
    />
  </aside>
</template>
