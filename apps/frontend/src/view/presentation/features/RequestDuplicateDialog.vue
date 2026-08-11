<script setup lang="ts">
import { ref } from "vue";
import { Copy, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AlertDialog from "@/view/presentation/controls/dialog/AlertDialog.vue";

defineProps<{
  requestName: string;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
const { t } = useI18n();
const open = ref(true);

/** Closes the warning without duplicating the saved request. */
function close(): void {
  open.value = false;
}
</script>

<template>
  <AlertDialog
    v-model:open="open"
    class="resource-dialog request-duplicate-dialog"
    aria-labelledby="request-duplicate-dialog-title"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="request-duplicate-dialog-title">
          {{ t("request.duplicateUnsavedTitle") }}
        </h2>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="discard-dialog-content">
        <p>{{ t("request.duplicateUnsavedMessage", { name: requestName }) }}</p>
        <footer class="resource-dialog-actions">
          <ButtonControl
            variant="secondary"
            :disabled="busy"
            autofocus
            @click="close"
          >
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl
            variant="primary"
            :busy="busy"
            @click="emit('confirm')"
          >
            <template #leading>
              <Copy :size="16" aria-hidden="true" />
            </template>
            {{ t("request.duplicateAction") }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </AlertDialog>
</template>
