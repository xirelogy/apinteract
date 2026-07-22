<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { X } from "@lucide/vue";

import type { TreeNode } from "@/model/contracts/backend";
import type { RequestTab } from "@/model/domain/application";

interface CollectionOption {
  readonly collectionId: string;
  readonly label: string;
}

const props = defineProps<{
  tab: RequestTab;
  rootNodes: readonly TreeNode[];
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [name: string, parentCollectionId: string];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const name = ref(props.tab.draft.name);
const options = computed(() => collectionOptions(props));
const parentCollectionId = ref(
  props.tab.pendingParentCollectionId ?? options.value[0]?.collectionId ?? "",
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

/** Flattens currently loaded collection branches into indented select options. */
function collectionOptions(input: {
  readonly rootNodes: readonly TreeNode[];
  readonly collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
}): CollectionOption[] {
  const result: CollectionOption[] = [];

  /** Visits one loaded tree level while retaining collection hierarchy. */
  function visit(nodes: readonly TreeNode[], depth: number): void {
    for (const node of nodes) {
      if (node.kind !== "collection") {
        continue;
      }
      result.push({
        collectionId: node.nodeId,
        label: `${"  ".repeat(depth)}${node.name}`,
      });
      visit(input.collectionChildren[node.nodeId] ?? [], depth + 1);
    }
  }

  visit(input.rootNodes, 0);
  return result;
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
        <label class="input-field">
          <span>Collection</span>
          <select
            v-model="parentCollectionId"
            class="select-input"
            aria-label="Destination collection"
            :disabled="busy || options.length === 0"
          >
            <option value="" disabled>Select a collection</option>
            <option
              v-for="option in options"
              :key="option.collectionId"
              :value="option.collectionId"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p v-if="options.length === 0" class="dialog-empty-message">
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
