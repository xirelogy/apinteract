<script setup lang="ts">
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AlertDialog from "@/view/presentation/controls/dialog/AlertDialog.vue";

defineProps<{
  open: boolean;
  titleId: string;
  title: string;
  message: string;
  additionalMessage: string;
  confirmLabel: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  confirm: [];
}>();
const { t } = useI18n();

/** Closes the confirmation without deleting its resource. */
function close(): void {
  emit("update:open", false);
}
</script>

<template>
  <AlertDialog
    :open="open"
    :busy="busy"
    class="resource-dialog resource-delete-dialog"
    :aria-labelledby="titleId"
    @update:open="emit('update:open', $event)"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 :id="titleId">{{ title }}</h2>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="resource-delete-content">
        <p>{{ message }}</p>
        <p>{{ additionalMessage }}</p>
        <footer class="resource-dialog-actions">
          <ButtonControl
            variant="secondary"
            :disabled="busy"
            autofocus
            @click="close"
          >
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl variant="danger" :busy="busy" @click="emit('confirm')">
            {{ confirmLabel }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </AlertDialog>
</template>
