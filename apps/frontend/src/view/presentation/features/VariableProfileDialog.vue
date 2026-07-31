<script setup lang="ts">
import { ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  VariableProfileView,
  VariableWrite,
} from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";

interface VariableFieldsEditorApi {
  writes(): VariableWrite[];
}

const props = defineProps<{
  profile: VariableProfileView;
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [variables: readonly VariableWrite[]];
}>();
const { t } = useI18n();
const open = ref(true);
const variableEditor = ref<VariableFieldsEditorApi | null>(null);

/** Emits the complete desired profile while preserving redacted secrets. */
function save(): void {
  if (props.canEdit) {
    emit("save", variableEditor.value?.writes() ?? []);
  }
}

/** Requests closure through the shared controlled-dialog lifecycle. */
function close(): void {
  open.value = false;
}
</script>

<template>
  <DialogControl
    v-model:open="open"
    class="resource-dialog environment-dialog"
    aria-labelledby="variable-profile-title"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="variable-profile-title">
          {{ t("variables.title", { name: profile.scopeName }) }}
        </h2>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <form class="resource-dialog-form" @submit.prevent="save">
        <p class="resource-dialog-context">{{ t("variables.description") }}</p>
        <VariableFieldsEditor
          ref="variableEditor"
          :profile-variables="profile.variables"
          :can-edit="canEdit"
          :busy="busy"
        />
        <footer class="resource-dialog-actions">
          <ButtonControl
            type="button"
            variant="secondary"
            :disabled="busy"
            @click="close"
          >
            {{
              canEdit ? t("common.actions.cancel") : t("common.actions.close")
            }}
          </ButtonControl>
          <ButtonControl
            v-if="canEdit"
            type="submit"
            variant="primary"
            :busy="busy"
          >
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </form>
    </div>
  </DialogControl>
</template>
