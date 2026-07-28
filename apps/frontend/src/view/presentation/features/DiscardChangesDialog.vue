<script setup lang="ts">
import { ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AlertDialog from "@/view/presentation/controls/dialog/AlertDialog.vue";

defineProps<{
  requestName: string;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  close: [];
  discard: [];
}>();

const open = ref(true);

/** Closes the discard confirmation without changing tab state. */
function close(): void {
  open.value = false;
}
</script>

<template>
  <AlertDialog
    v-model:open="open"
    class="resource-dialog discard-dialog"
    aria-labelledby="discard-dialog-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="discard-dialog-title">{{ t("request.discard.title") }}</h2>
        <IconButton :label="t('common.actions.close')" @click="close">
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="discard-dialog-content">
        <p>{{ t("request.discard.message", { name: requestName }) }}</p>
        <footer class="resource-dialog-actions">
          <ButtonControl variant="secondary" autofocus @click="close">
            {{ t("request.discard.keepEditing") }}
          </ButtonControl>
          <ButtonControl variant="danger" @click="emit('discard')">
            {{ t("common.actions.discard") }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </AlertDialog>
</template>
