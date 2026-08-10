<script setup lang="ts">
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AlertDialog from "@/view/presentation/controls/dialog/AlertDialog.vue";

defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  confirm: [];
}>();
const { t } = useI18n();

/** Closes the confirmation while retaining the active session. */
function close(): void {
  emit("update:open", false);
}

/** Confirms logout after closing the modal surface. */
function confirm(): void {
  close();
  emit("confirm");
}
</script>

<template>
  <AlertDialog
    :open="open"
    class="resource-dialog logout-confirmation-dialog"
    aria-labelledby="logout-confirmation-dialog-title"
    @update:open="emit('update:open', $event)"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="logout-confirmation-dialog-title">
          {{ t("header.logoutAction") }}
        </h2>
        <IconButton :label="t('common.actions.close')" @click="close">
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="logout-confirmation-content">
        <p>{{ t("header.logoutConfirmation") }}</p>
        <footer class="resource-dialog-actions">
          <ButtonControl variant="secondary" autofocus @click="close">
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl variant="danger" @click="confirm">
            {{ t("header.logoutAction") }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </AlertDialog>
</template>
