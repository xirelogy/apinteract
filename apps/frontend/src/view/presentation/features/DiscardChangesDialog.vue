<script setup lang="ts">
import { onMounted, ref } from "vue";
import { X } from "@lucide/vue";

defineProps<{
  requestName: string;
}>();

const emit = defineEmits<{
  close: [];
  discard: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);

onMounted(() => dialog.value?.showModal());

/** Closes the discard confirmation without changing tab state. */
function close(): void {
  dialog.value?.close();
}
</script>

<template>
  <dialog
    ref="dialog"
    class="resource-dialog discard-dialog"
    aria-labelledby="discard-dialog-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="discard-dialog-title">Discard changes?</h2>
        <button
          class="icon-button"
          type="button"
          title="Close"
          aria-label="Close"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </button>
      </header>
      <div class="discard-dialog-content">
        <p>Unsaved changes to {{ requestName }} will be lost.</p>
        <footer class="resource-dialog-actions">
          <button class="secondary-button" type="button" @click="close">
            Keep editing
          </button>
          <button class="danger-button" type="button" @click="emit('discard')">
            Discard
          </button>
        </footer>
      </div>
    </div>
  </dialog>
</template>
