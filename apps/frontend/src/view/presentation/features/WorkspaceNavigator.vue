<script setup lang="ts">
import { computed, ref } from "vue";
import { FolderPlus, Plus } from "@lucide/vue";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";

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

const workspaceName = ref("");
const collectionName = ref("");
const requestName = ref("");
const requestUrl = ref("http://fixture:8090/hello");

const collections = computed(() =>
  props.rootNodes.filter((node) => node.kind === "collection"),
);
const requests = computed(() =>
  props.collectionNodes.filter((node) => node.kind === "request"),
);

/** Submits a non-empty workspace name and resets its field. */
function submitWorkspace(): void {
  if (workspaceName.value.trim() !== "") {
    emit("createWorkspace", workspaceName.value);
    workspaceName.value = "";
  }
}

/** Submits a non-empty collection under the selected workspace. */
function submitCollection(): void {
  if (collectionName.value.trim() !== "") {
    emit("createCollection", collectionName.value);
    collectionName.value = "";
  }
}

/** Submits a named request with a non-empty target URL. */
function submitRequest(): void {
  if (requestName.value.trim() !== "" && requestUrl.value.trim() !== "") {
    emit("createRequest", requestName.value, requestUrl.value);
    requestName.value = "";
  }
}
</script>

<template>
  <aside class="workspace-navigator" aria-label="Workspace navigation">
    <div class="navigator-section">
      <label class="field-label" for="workspace-select">Workspace</label>
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
      <form class="inline-create" @submit.prevent="submitWorkspace">
        <input
          v-model="workspaceName"
          class="text-input"
          aria-label="New workspace name"
          placeholder="New workspace"
          :disabled="busy"
        />
        <button
          class="icon-button"
          type="submit"
          title="Create workspace"
          aria-label="Create workspace"
          :disabled="busy"
        >
          <Plus :size="17" aria-hidden="true" />
        </button>
      </form>
    </div>

    <div v-if="selectedWorkspaceId" class="navigator-section">
      <div class="section-heading">
        <span>Collections</span>
        <FolderPlus :size="15" aria-hidden="true" />
      </div>
      <nav class="tree-list" aria-label="Collections">
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
      <form class="inline-create" @submit.prevent="submitCollection">
        <input
          v-model="collectionName"
          class="text-input"
          aria-label="New collection name"
          placeholder="New collection"
          :disabled="busy"
        />
        <button
          class="icon-button"
          type="submit"
          title="Create collection"
          aria-label="Create collection"
          :disabled="busy"
        >
          <Plus :size="17" aria-hidden="true" />
        </button>
      </form>
    </div>

    <div v-if="selectedCollectionId" class="navigator-section navigator-grow">
      <div class="section-heading">Requests</div>
      <nav class="tree-list" aria-label="Requests">
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
      <form class="create-request-form" @submit.prevent="submitRequest">
        <input
          v-model="requestName"
          class="text-input"
          aria-label="New request name"
          placeholder="Request name"
          :disabled="busy"
        />
        <input
          v-model="requestUrl"
          class="text-input"
          aria-label="New request URL"
          placeholder="https://api.example.com/path"
          inputmode="url"
          :disabled="busy"
        />
        <button class="secondary-button" type="submit" :disabled="busy">
          <Plus :size="16" aria-hidden="true" />
          Add request
        </button>
      </form>
    </div>
  </aside>
</template>
