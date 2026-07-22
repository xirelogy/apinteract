<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { X } from "@lucide/vue";

import type { TreeNode } from "@/model/contracts/backend";
import type { RequestTab } from "@/model/domain/application";
import CollectionPickerTreeNode from "./CollectionPickerTreeNode.vue";

const props = defineProps<{
  tab: RequestTab;
  rootNodes: readonly TreeNode[];
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  expandCollection: [collectionId: string];
  save: [name: string, parentCollectionId: string];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const name = ref(props.tab.draft.name);
const collectionRoots = computed(() =>
  props.rootNodes.filter((node) => node.kind === "collection"),
);
const parentCollectionId = ref(
  props.tab.pendingParentCollectionId ?? collectionRoots.value[0]?.nodeId ?? "",
);
const expandedCollectionIds = ref(
  collectionPath(
    props.rootNodes,
    props.collectionChildren,
    parentCollectionId.value,
  ),
);
const canSave = computed(
  () => name.value.trim() !== "" && parentCollectionId.value !== "",
);

onMounted(() => dialog.value?.showModal());

/** Closes the native save dialog. */
function close(): void {
  dialog.value?.close();
}

/** Closes the dialog only when its backdrop is selected. */
function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) {
    close();
  }
}

/** Emits a normalized saved-request destination. */
function save(): void {
  if (!canSave.value) {
    return;
  }
  emit("save", name.value.trim(), parentCollectionId.value);
}

/** Expands or collapses one picker branch and requests unloaded children. */
function toggleCollection(collectionId: string): void {
  if (expandedCollectionIds.value.includes(collectionId)) {
    expandedCollectionIds.value = expandedCollectionIds.value.filter(
      (candidate) => candidate !== collectionId,
    );
    return;
  }
  expandedCollectionIds.value = [...expandedCollectionIds.value, collectionId];
  if (props.collectionChildren[collectionId] === undefined) {
    emit("expandCollection", collectionId);
  }
}

/** Finds the loaded collection path leading to a selected destination. */
function collectionPath(
  nodes: readonly TreeNode[],
  children: Readonly<Record<string, readonly TreeNode[]>>,
  collectionId: string,
): string[] {
  for (const node of nodes) {
    if (node.kind !== "collection") {
      continue;
    }
    if (node.nodeId === collectionId) {
      return [node.nodeId];
    }
    const childPath = collectionPath(
      children[node.nodeId] ?? [],
      children,
      collectionId,
    );
    if (childPath.length > 0) {
      return [node.nodeId, ...childPath];
    }
  }
  return [];
}
</script>

<template>
  <dialog
    ref="dialog"
    class="resource-dialog"
    aria-labelledby="save-request-title"
    @click="closeFromBackdrop"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="save-request-title">Save request</h2>
        <button
          class="icon-button"
          type="button"
          title="Close"
          aria-label="Close"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </button>
      </header>
      <form class="resource-dialog-form" @submit.prevent="save">
        <label class="input-field">
          <span>Request name</span>
          <input
            v-model="name"
            class="text-input"
            aria-label="Saved request name"
            autocomplete="off"
            autofocus
            :disabled="busy"
          />
        </label>
        <fieldset class="collection-picker-field">
          <legend>Collection</legend>
          <div
            v-if="collectionRoots.length > 0"
            class="collection-picker"
            role="tree"
            aria-label="Destination collection"
          >
            <ul class="workspace-tree-root" role="group">
              <CollectionPickerTreeNode
                v-for="node in collectionRoots"
                :key="node.nodeId"
                :node="node"
                :collection-children="collectionChildren"
                :expanded-collection-ids="expandedCollectionIds"
                :selected-collection-id="parentCollectionId"
                :busy="busy"
                @select="parentCollectionId = $event"
                @toggle="toggleCollection"
              />
            </ul>
          </div>
        </fieldset>
        <p v-if="collectionRoots.length === 0" class="dialog-empty-message">
          Create a collection before saving this request.
        </p>
        <footer class="resource-dialog-actions">
          <button
            class="secondary-button"
            type="button"
            :disabled="busy"
            @click="close"
          >
            Cancel
          </button>
          <button
            class="primary-button"
            type="submit"
            :disabled="busy || !canSave"
          >
            Save
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
