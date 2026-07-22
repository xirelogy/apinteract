<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { X } from "@lucide/vue";

type CreationKind = "workspace" | "collection";

const props = defineProps<{
  kind: CreationKind;
  busy: boolean;
  context?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  submit: [name: string];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const name = ref("");

const title = computed(() =>
  props.kind === "collection" && props.context != null
    ? "New subcollection"
    : `New ${props.kind}`,
);
const nameLabel = computed(
  () => `${props.kind[0]?.toUpperCase()}${props.kind.slice(1)} name`,
);
const canSubmit = computed(() => name.value.trim() !== "");

onMounted(() => dialog.value?.showModal());

/** Closes the native modal and lets its close event notify the navigator. */
function close(): void {
  dialog.value?.close();
}

/** Closes the modal when its backdrop, rather than its content, is clicked. */
function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) {
    close();
  }
}

/** Emits normalized creation fields and closes the completed modal. */
function submit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit("submit", name.value.trim());
  close();
}
</script>

<template>
  <dialog
    ref="dialog"
    class="resource-dialog"
    aria-labelledby="resource-dialog-title"
    @click="closeFromBackdrop"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <div>
          <h2 id="resource-dialog-title">{{ title }}</h2>
          <p v-if="context" class="resource-dialog-context">{{ context }}</p>
        </div>
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

      <form class="resource-dialog-form" @submit.prevent="submit">
        <label class="input-field">
          <span>{{ nameLabel }}</span>
          <input
            v-model="name"
            class="text-input"
            :aria-label="nameLabel"
            autocomplete="off"
            autofocus
            :disabled="busy"
          />
        </label>

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
            :disabled="busy || !canSubmit"
          >
            Create
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
