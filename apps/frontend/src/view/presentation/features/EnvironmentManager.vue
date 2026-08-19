<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Layers3, Save, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  EnvironmentSummary,
  EnvironmentVariableWrite,
} from "@/model/contracts/backend";
import type {
  EnvironmentDraft,
  EnvironmentEditorTab,
} from "@/model/domain/application";
import ActionMenu, {
  type ActionMenuItem,
} from "@/view/presentation/controls/ActionMenu.vue";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";
import ResourceDeleteDialog from "./ResourceDeleteDialog.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";

interface VariableFieldsEditorApi {
  writes(): EnvironmentVariableWrite[];
}

const props = withDefaults(
  defineProps<{
    environments: readonly EnvironmentSummary[];
    selectedEnvironmentId: string | null;
    editorTab?: EnvironmentEditorTab | null;
    showToolbar?: boolean;
    canEdit: boolean;
    busy: boolean;
  }>(),
  { editorTab: null, showToolbar: true },
);
const emit = defineEmits<{
  select: [environmentId: string | null];
  openEditor: [environmentId: string | null];
  change: [tabId: string, draft: EnvironmentDraft];
  saveEditor: [tabId: string];
  delete: [environmentId: string, revision: number];
}>();
const { t } = useI18n();
const name = ref("");
const editingId = ref<string | null>(null);
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
const variableEditorKey = ref(0);
const includedEnvironmentIds = ref<string[]>([]);
const includeCandidateId = ref("");
const deleteConfirmationOpen = ref(false);
const deletionTarget = ref<{
  readonly environmentId: string;
  readonly revision: number;
  readonly name: string;
} | null>(null);
const editorReady = computed(() => props.editorTab !== null);
const options = computed(() => [
  { value: "", label: t("environment.none") },
  ...props.environments.map((environment) => ({
    value: environment.environmentId,
    label: environment.name,
  })),
]);
const availableIncludeOptions = computed(() =>
  props.environments
    .filter(
      (environment) =>
        environment.environmentId !== editingId.value &&
        !includedEnvironmentIds.value.includes(environment.environmentId),
    )
    .map((environment) => ({
      value: environment.environmentId,
      label: environment.name,
    })),
);
const environmentActions = computed<readonly ActionMenuItem[]>(() => {
  const selected = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  return [
    ...(selected === undefined
      ? []
      : [
          {
            value: `edit:${selected.environmentId}`,
            label: t("environment.editNamed", { name: selected.name }),
          },
        ]),
    ...(props.canEdit
      ? [{ value: "create", label: t("environment.createNew") }]
      : []),
    ...props.environments
      .filter(
        (environment) =>
          environment.environmentId !== props.selectedEnvironmentId,
      )
      .map((environment) => ({
        value: `edit:${environment.environmentId}`,
        label: t("environment.editNamed", { name: environment.name }),
      })),
  ];
});
watch(
  () => props.editorTab?.tabId ?? null,
  () => {
    const tab = props.editorTab;
    if (tab === null) return;
    editingId.value = tab.environment?.environmentId ?? null;
    name.value = tab.draft.name;
    includedEnvironmentIds.value = [...tab.draft.includedEnvironmentIds];
    includeCandidateId.value = "";
    variableEditorKey.value += 1;
  },
  { immediate: true },
);

/** Opens the manager with a clean create form. */
function createEnvironment(): void {
  emit("openEditor", null);
}

/** Opens and requests one redacted environment profile. */
function editEnvironment(environmentId: string): void {
  emit("openEditor", environmentId);
}

/** Returns valid replacements for one included-environment row. */
function includedEnvironmentOptions(currentId: string) {
  return props.environments
    .filter(
      (environment) =>
        environment.environmentId !== editingId.value &&
        (environment.environmentId === currentId ||
          !includedEnvironmentIds.value.includes(environment.environmentId)),
    )
    .map((environment) => ({
      value: environment.environmentId,
      label: environment.name,
    }));
}

/** Adds the selected environment at the highest included precedence. */
function addIncludedEnvironment(): void {
  const candidate = includeCandidateId.value;
  if (candidate === "" || includedEnvironmentIds.value.includes(candidate)) {
    return;
  }
  includedEnvironmentIds.value.push(candidate);
  includeCandidateId.value = "";
  publishDraft();
}

/** Replaces one include while retaining uniqueness and order. */
function replaceIncludedEnvironment(
  index: number,
  environmentId: string,
): void {
  if (
    environmentId !== "" &&
    !includedEnvironmentIds.value.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && candidate === environmentId,
    )
  ) {
    includedEnvironmentIds.value[index] = environmentId;
    publishDraft();
  }
}

/** Removes one environment from the composition list. */
function removeIncludedEnvironment(index: number): void {
  includedEnvironmentIds.value.splice(index, 1);
  publishDraft();
}

/** Moves one environment within the low-to-high precedence list. */
function moveIncludedEnvironment(fromIndex: number, toIndex: number): void {
  const [environmentId] = includedEnvironmentIds.value.splice(fromIndex, 1);
  if (environmentId !== undefined) {
    includedEnvironmentIds.value.splice(toIndex, 0, environmentId);
    publishDraft();
  }
}

const includeReorder = useRowReorder({
  canMove: (index) => includedEnvironmentIds.value[index] !== undefined,
  move: moveIncludedEnvironment,
  isDisabled: () => props.busy || !props.canEdit,
});

/** Routes one toolbar menu action without changing the active environment. */
function selectEnvironmentAction(action: string): void {
  if (action === "create") {
    createEnvironment();
  } else if (action.startsWith("edit:")) {
    editEnvironment(action.slice("edit:".length));
  }
}

/** Publishes the current environment draft to its owning workbench tab. */
function publishDraft(variables?: readonly EnvironmentVariableWrite[]): void {
  const tab = props.editorTab;
  if (tab === null) return;
  emit("change", tab.tabId, {
    name: name.value,
    variables:
      variables ?? variableEditor.value?.writes() ?? tab.draft.variables,
    includedEnvironmentIds: includedEnvironmentIds.value,
  });
}

/** Publishes and requests persistence for the current environment tab. */
function save(): void {
  const tab = props.editorTab;
  if (tab === null) return;
  publishDraft();
  emit("saveEditor", tab.tabId);
}

/** Opens styled confirmation for the currently loaded saved environment. */
function requestEnvironmentDeletion(): void {
  const environment = props.editorTab?.environment ?? null;
  if (
    environment !== null &&
    editingId.value === environment.environmentId &&
    props.canEdit
  ) {
    deletionTarget.value = {
      environmentId: environment.environmentId,
      revision: environment.revision,
      name: environment.name,
    };
    deleteConfirmationOpen.value = true;
  }
}

/** Emits deletion while retaining both modal surfaces until persistence succeeds. */
function confirmEnvironmentDeletion(): void {
  const target = deletionTarget.value;
  if (target !== null) {
    emit("delete", target.environmentId, target.revision);
  }
}

/** Synchronizes confirmation visibility and releases a cancelled target. */
function setDeleteConfirmationOpen(confirmationOpen: boolean): void {
  deleteConfirmationOpen.value = confirmationOpen;
  if (!confirmationOpen) deletionTarget.value = null;
}
</script>

<template>
  <section
    v-if="showToolbar"
    class="environment-toolbar"
    :aria-label="t('environment.label')"
  >
    <SelectMenu
      :model-value="selectedEnvironmentId ?? ''"
      :options="options"
      :label="t('environment.select')"
      density="compact"
      :disabled="busy || !canEdit"
      @update:model-value="emit('select', $event || null)"
    >
      <template #selected="{ option }">
        <Layers3
          class="environment-selector-icon"
          :class="{
            'environment-selection-empty': selectedEnvironmentId === null,
          }"
          :size="17"
          aria-hidden="true"
        />
        <span
          class="environment-selector-name"
          :class="{
            'environment-selection-empty': selectedEnvironmentId === null,
          }"
        >
          {{ option?.label ?? t("environment.none") }}
        </span>
      </template>
    </SelectMenu>
    <ActionMenu
      :label="t('environment.manage')"
      :items="environmentActions"
      :disabled="busy || environmentActions.length === 0"
      @select="selectEnvironmentAction"
    />
  </section>

  <section
    v-if="editorTab"
    id="request-workbench"
    class="resource-editor-panel environment-dialog"
    aria-labelledby="environment-dialog-title"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header resource-editor-header">
        <div class="resource-editor-title">
          <Layers3
            class="resource-editor-kind-icon"
            :size="19"
            aria-hidden="true"
          />
          <TextInput
            id="environment-dialog-title"
            v-model="name"
            class="request-name-input"
            :aria-label="t('common.fields.name')"
            :placeholder="t('environment.label')"
            :disabled="busy || !canEdit"
            required
            autocomplete="off"
            @input="publishDraft()"
          />
        </div>
        <div class="command-bar resource-editor-actions">
          <ButtonControl
            v-if="canEdit"
            type="submit"
            form="environment-editor-form"
            variant="primary"
            :aria-label="t('common.actions.save')"
            :title="t('common.actions.save')"
            :busy="busy"
          >
            <template #leading>
              <Save :size="16" aria-hidden="true" />
            </template>
            {{ t("common.actions.save") }}
          </ButtonControl>
          <ButtonControl
            v-if="editingId && canEdit"
            variant="danger-outline"
            :aria-label="t('common.actions.delete')"
            :title="t('common.actions.delete')"
            :disabled="busy"
            @click="requestEnvironmentDeletion"
          >
            <template #leading>
              <Trash2 :size="16" aria-hidden="true" />
            </template>
            {{ t("common.actions.delete") }}
          </ButtonControl>
        </div>
      </header>
      <p
        v-if="editorTab.omittedSecretValues"
        class="resource-editor-recovery-warning"
        role="status"
      >
        {{ t("request.recovery.secrets-omitted") }}
      </p>
      <form
        id="environment-editor-form"
        class="resource-dialog-form"
        @submit.prevent="save"
      >
        <section
          class="environment-includes"
          aria-labelledby="environment-includes-title"
        >
          <h3
            id="environment-includes-title"
            class="resource-dialog-section-title"
          >
            {{ t("environment.includedEnvironments") }}
          </h3>
          <p class="resource-dialog-context environment-includes-description">
            {{ t("environment.includedEnvironmentsDescription") }}
          </p>
          <div
            v-for="(environmentId, index) in includedEnvironmentIds"
            :key="environmentId"
            class="environment-include-row"
            :class="includeReorder.classes(index)"
            @dragover.stop="includeReorder.updateDropTarget($event, index)"
            @drop.stop="includeReorder.finishDrop($event)"
          >
            <RowReorderHandle
              :label="
                t('environment.reorderIncludedEnvironment', {
                  index: index + 1,
                })
              "
              :disabled="busy || !canEdit"
              @drag-start="includeReorder.startDrag($event, index)"
              @drag-end="includeReorder.cancelDrag"
              @move="includeReorder.moveByKeyboard(index, $event)"
            />
            <SelectMenu
              :model-value="environmentId"
              :options="includedEnvironmentOptions(environmentId)"
              :label="
                t('environment.includedEnvironment', { index: index + 1 })
              "
              density="compact"
              :disabled="busy || !canEdit"
              @update:model-value="replaceIncludedEnvironment(index, $event)"
            />
            <IconButton
              :label="
                t('environment.removeIncludedEnvironment', {
                  index: index + 1,
                })
              "
              size="compact"
              :disabled="busy || !canEdit"
              @click="removeIncludedEnvironment(index)"
            >
              <X :size="15" aria-hidden="true" />
            </IconButton>
          </div>
          <div
            v-if="availableIncludeOptions.length > 0"
            class="environment-include-picker"
          >
            <SelectMenu
              v-model="includeCandidateId"
              :options="availableIncludeOptions"
              :label="t('environment.includeEnvironment')"
              density="compact"
              :disabled="busy || !canEdit"
            />
            <ButtonControl
              type="button"
              variant="secondary"
              :disabled="busy || !canEdit || includeCandidateId === ''"
              @click="addIncludedEnvironment"
            >
              {{ t("environment.includeAction") }}
            </ButtonControl>
          </div>
        </section>
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
            editingId === null ? [] : (editorTab.environment?.variables ?? [])
          "
          :draft-variables="editorTab.draft.variables"
          :inherited-variables="
            editingId === null
              ? []
              : (editorTab.environment?.inheritedVariables ?? [])
          "
          :can-edit="canEdit"
          :busy="busy"
          @change="publishDraft"
        />
      </form>
    </div>
  </section>

  <ResourceDeleteDialog
    v-if="deletionTarget"
    class="environment-delete-dialog"
    :open="deleteConfirmationOpen"
    title-id="environment-delete-dialog-title"
    :title="t('environment.deleteTitle')"
    :message="t('environment.deleteMessage', { name: deletionTarget.name })"
    :additional-message="t('environment.deleteUnsavedChanges')"
    :confirm-label="t('environment.deleteAction')"
    :busy="busy"
    @update:open="setDeleteConfirmationOpen"
    @confirm="confirmEnvironmentDeletion"
  />
</template>
