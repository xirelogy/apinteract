<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";

type CreationKind = "workspace" | "collection";

const props = defineProps<{
  kind: CreationKind;
  busy: boolean;
  context?: string | null;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  close: [];
  submit: [name: string];
}>();

const open = ref(true);
const name = ref("");

const title = computed(() =>
  props.kind === "workspace"
    ? t("resource.newWorkspace")
    : props.context != null
      ? t("collection.newSubcollection")
      : t("collection.new"),
);
const nameLabel = computed(() =>
  props.kind === "workspace"
    ? t("resource.workspaceName")
    : t("collection.name"),
);
const canSubmit = computed(() => name.value.trim() !== "");

/** Requests closure through the shared controlled dialog lifecycle. */
function close(): void {
  open.value = false;
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
  <DialogControl
    v-model:open="open"
    class="resource-dialog"
    aria-labelledby="resource-dialog-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <div>
          <h2 id="resource-dialog-title">{{ title }}</h2>
          <p v-if="context" class="resource-dialog-context">{{ context }}</p>
        </div>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>

      <form class="resource-dialog-form" @submit.prevent="submit">
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="nameLabel"
        >
          <TextInput
            :id="controlId"
            v-model="name"
            :aria-describedby="describedBy"
            :invalid="invalid"
            autocomplete="off"
            autofocus
            :disabled="busy"
          />
        </FormField>

        <footer class="resource-dialog-actions">
          <ButtonControl variant="secondary" :disabled="busy" @click="close">
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl
            variant="primary"
            type="submit"
            :disabled="busy || !canSubmit"
          >
            {{ t("common.actions.create") }}
          </ButtonControl>
        </footer>
      </form>
    </div>
  </DialogControl>
</template>
