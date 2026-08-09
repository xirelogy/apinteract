<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Settings } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  EnvironmentSummary,
  EnvironmentVariableWrite,
  EnvironmentView,
} from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";

interface VariableFieldsEditorApi {
  writes(): EnvironmentVariableWrite[];
}

const props = defineProps<{
  environments: readonly EnvironmentSummary[];
  selectedEnvironmentId: string | null;
  environment: EnvironmentView | null;
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  select: [environmentId: string | null];
  load: [environmentId: string];
  create: [name: string, variables: readonly EnvironmentVariableWrite[]];
  save: [
    environmentId: string,
    revision: number,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
  ];
  delete: [environmentId: string, revision: number];
}>();
const { t } = useI18n();
const open = ref(false);
const name = ref("");
const editingId = ref<string | null>(null);
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
const variableEditorKey = ref(0);
const editorReady = computed(
  () =>
    editingId.value === null ||
    props.environment?.environmentId === editingId.value,
);
const options = computed(() => [
  { value: "", label: t("environment.none") },
  ...props.environments.map((environment) => ({
    value: environment.environmentId,
    label: environment.name,
  })),
]);
watch(
  () => props.environment,
  (environment) => {
    if (
      environment === null ||
      (editingId.value !== null &&
        environment.environmentId !== editingId.value)
    ) {
      return;
    }
    editingId.value = environment.environmentId;
    name.value = environment.name;
  },
);

/** Opens the manager with a clean create form. */
function createEnvironment(): void {
  editingId.value = null;
  name.value = "";
  variableEditorKey.value += 1;
  open.value = true;
}

/** Opens and requests one redacted environment profile. */
function editEnvironment(environmentId: string): void {
  editingId.value = environmentId;
  name.value = "";
  variableEditorKey.value += 1;
  open.value = true;
  emit("load", environmentId);
}

/** Emits create or optimistic update from the current complete profile. */
function save(): void {
  const writes = variableEditor.value?.writes() ?? [];
  const environment = props.environment;
  if (editingId.value === null) {
    emit("create", name.value, writes);
  } else if (environment?.environmentId === editingId.value) {
    emit(
      "save",
      environment.environmentId,
      environment.revision,
      name.value,
      writes,
    );
  }
}

/** Closes the editor only after its owning controller confirms persistence. */
function finishMutation(): void {
  open.value = false;
}

defineExpose({ finishMutation });

/** Confirms destructive deletion using the browser's accessible prompt. */
function deleteEnvironment(): void {
  const environment = props.environment;
  if (
    environment !== null &&
    window.confirm(
      t("environment.deleteConfirmation", { name: environment.name }),
    )
  ) {
    emit("delete", environment.environmentId, environment.revision);
  }
}
</script>

<template>
  <section class="environment-toolbar" :aria-label="t('environment.label')">
    <SelectMenu
      :model-value="selectedEnvironmentId ?? ''"
      :options="options"
      :label="t('environment.select')"
      density="compact"
      :disabled="busy || !canEdit"
      @update:model-value="emit('select', $event || null)"
    />
    <IconButton
      :label="t('environment.manage')"
      :disabled="busy"
      @click="
        selectedEnvironmentId
          ? editEnvironment(selectedEnvironmentId)
          : createEnvironment()
      "
    >
      <Settings :size="17" aria-hidden="true" />
    </IconButton>
  </section>

  <DialogControl
    v-model:open="open"
    class="resource-dialog environment-dialog"
    aria-labelledby="environment-dialog-title"
    :busy="busy"
  >
    <div class="resource-dialog-surface">
      <form class="resource-dialog-form" @submit.prevent="save">
        <header class="resource-dialog-header">
          <h2 id="environment-dialog-title">
            {{ editingId ? t("environment.edit") : t("environment.create") }}
          </h2>
        </header>
        <label class="field-label">
          {{ t("common.fields.name") }}
          <TextInput
            v-model="name"
            :disabled="busy || !canEdit"
            required
            autocomplete="off"
          />
        </label>
        <h3 class="resource-dialog-section-title">
          {{ t("environment.variables") }}
        </h3>
        <p v-if="!editorReady" class="resource-dialog-context" role="status">
          {{ t("variables.loading") }}
        </p>
        <VariableFieldsEditor
          v-else
          :key="variableEditorKey"
          ref="variableEditor"
          :profile-variables="
            editingId === null ? [] : (environment?.variables ?? [])
          "
          :can-edit="canEdit"
          :busy="busy"
        />
        <footer class="resource-dialog-actions">
          <ButtonControl
            type="button"
            variant="secondary"
            :disabled="busy"
            @click="open = false"
          >
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl
            v-if="editingId && canEdit"
            type="button"
            variant="danger"
            :disabled="busy"
            @click="deleteEnvironment"
          >
            {{ t("common.actions.delete") }}
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
