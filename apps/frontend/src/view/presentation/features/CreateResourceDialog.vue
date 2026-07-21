<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { X } from "@lucide/vue";

type CreationKind = "workspace" | "collection" | "request";

const props = defineProps<{
  kind: CreationKind;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [name: string, targetUrl: string | null];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const name = ref("");
const targetUrl = ref("http://127.0.0.1:8090/hello");

const title = computed(() => `New ${props.kind}`);
const nameLabel = computed(
  () => `${props.kind[0]?.toUpperCase()}${props.kind.slice(1)} name`,
);
const canSubmit = computed(
  () =>
    name.value.trim() !== "" &&
    (props.kind !== "request" || targetUrl.value.trim() !== ""),
);

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
  emit(
    "submit",
    name.value.trim(),
    props.kind === "request" ? targetUrl.value.trim() : null,
  );
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
        <h2 id="resource-dialog-title">{{ title }}</h2>
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

        <label v-if="kind === 'request'" class="input-field">
          <span>Target URL</span>
          <input
            v-model="targetUrl"
            class="text-input dialog-url-input"
            aria-label="New request URL"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
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
