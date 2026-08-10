<script setup lang="ts">
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";

defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();
const { t } = useI18n();

/** Closes the account options without changing the selected preference. */
function close(): void {
  emit("update:open", false);
}
</script>

<template>
  <DialogControl
    :open="open"
    class="resource-dialog account-options-dialog"
    aria-labelledby="account-options-dialog-title"
    @update:open="emit('update:open', $event)"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="account-options-dialog-title">{{ t("header.options") }}</h2>
        <IconButton :label="t('common.actions.close')" @click="close">
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="resource-dialog-form">
        <FormField v-slot="{ controlId }" :label="t('common.language.label')">
          <LocaleSelector :input-id="controlId" mobile-presentation="popover" />
        </FormField>
        <footer class="resource-dialog-actions">
          <ButtonControl variant="primary" @click="close">
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </DialogControl>
</template>
