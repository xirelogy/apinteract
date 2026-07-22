<script setup lang="ts">
import { onMounted, ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

defineProps<{
  requestName: string;
}>();
const { t } = useI18n();

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
        <h2 id="discard-dialog-title">{{ t("request.discard.title") }}</h2>
        <button
          class="icon-button"
          type="button"
          :title="t('common.actions.close')"
          :aria-label="t('common.actions.close')"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </button>
      </header>
      <div class="discard-dialog-content">
        <p>{{ t("request.discard.message", { name: requestName }) }}</p>
        <footer class="resource-dialog-actions">
          <button class="secondary-button" type="button" @click="close">
            {{ t("request.discard.keepEditing") }}
          </button>
          <button class="danger-button" type="button" @click="emit('discard')">
            {{ t("common.actions.discard") }}
          </button>
        </footer>
      </div>
    </div>
  </dialog>
</template>
