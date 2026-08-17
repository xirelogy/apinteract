<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Layers3, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  EnvironmentSummary,
  EnvironmentVariableWrite,
  EnvironmentView,
} from "@/model/contracts/backend";
import ActionMenu, {
  type ActionMenuItem,
} from "@/view/presentation/controls/ActionMenu.vue";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import ResourceDeleteDialog from "./ResourceDeleteDialog.vue";
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
  create: [
    name: string,
    variables: readonly EnvironmentVariableWrite[],
    includedEnvironmentIds: readonly string[],
  ];
  save: [
    environmentId: string,
    revision: number,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
    includedEnvironmentIds: readonly string[],
  ];
  delete: [environmentId: string, revision: number];
}>();
const { t } = useI18n();
const open = ref(false);
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
const editorReady = computed(
  () =>
    editingId.value === null ||
    props.environment?.environmentId === editingId.value,
);
const editorEnvironmentName = computed(
  () =>
    props.environments.find(
      (environment) => environment.environmentId === editingId.value,
    )?.name ?? name.value,
);
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
const editorActions = computed<readonly ActionMenuItem[]>(() => [
  {
    value: "delete",
    label: t("environment.deleteAction"),
    variant: "danger",
    disabled: !editorReady.value,
  },
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
    includedEnvironmentIds.value = environment.includedEnvironments.map(
      (included) => included.environmentId,
    );
    includeCandidateId.value = "";
  },
);

/** Opens the manager with a clean create form. */
function createEnvironment(): void {
  editingId.value = null;
  name.value = "";
  includedEnvironmentIds.value = [];
  includeCandidateId.value = "";
  variableEditorKey.value += 1;
  open.value = true;
}

/** Opens and requests one redacted environment profile. */
function editEnvironment(environmentId: string): void {
  editingId.value = environmentId;
  name.value =
    props.environment?.environmentId === environmentId
      ? props.environment.name
      : "";
  variableEditorKey.value += 1;
  open.value = true;
  emit("load", environmentId);
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
  }
}

/** Removes one environment from the composition list. */
function removeIncludedEnvironment(index: number): void {
  includedEnvironmentIds.value.splice(index, 1);
}

/** Moves one environment within the low-to-high precedence list. */
function moveIncludedEnvironment(fromIndex: number, toIndex: number): void {
  const [environmentId] = includedEnvironmentIds.value.splice(fromIndex, 1);
  if (environmentId !== undefined) {
    includedEnvironmentIds.value.splice(toIndex, 0, environmentId);
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

/** Requests closure through the shared controlled-dialog lifecycle. */
function close(): void {
  deleteConfirmationOpen.value = false;
  deletionTarget.value = null;
  open.value = false;
}

/** Emits create or optimistic update from the current complete profile. */
function save(): void {
  const writes = variableEditor.value?.writes() ?? [];
  const environment = props.environment;
  if (editingId.value === null) {
    emit("create", name.value, writes, includedEnvironmentIds.value);
  } else if (environment?.environmentId === editingId.value) {
    emit(
      "save",
      environment.environmentId,
      environment.revision,
      name.value,
      writes,
      includedEnvironmentIds.value,
    );
  }
}

/** Closes the editor only after its owning controller confirms persistence. */
function finishMutation(): void {
  deleteConfirmationOpen.value = false;
  deletionTarget.value = null;
  open.value = false;
}

defineExpose({ finishMutation });

/** Opens styled confirmation for the currently loaded saved environment. */
function requestEnvironmentDeletion(): void {
  const environment = props.environment;
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

/** Routes one infrequent editor action from the header overflow menu. */
function selectEditorAction(action: string): void {
  if (action === "delete") requestEnvironmentDeletion();
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
  <section class="environment-toolbar" :aria-label="t('environment.label')">
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

  <DialogControl
    v-model:open="open"
    class="resource-dialog environment-dialog"
    aria-labelledby="environment-dialog-title"
    :busy="busy"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="environment-dialog-title">
          {{ editingId ? t("environment.edit") : t("environment.create") }}
        </h2>
        <div class="resource-dialog-header-actions">
          <ActionMenu
            v-if="editingId && canEdit"
            :label="
              t('environment.moreActions', {
                name: editorEnvironmentName,
              })
            "
            :items="editorActions"
            :disabled="busy"
            @select="selectEditorAction"
          >
            <template #item="{ item }">
              <Trash2
                class="action-menu-item-icon"
                :size="16"
                aria-hidden="true"
              />
              <span>{{ item.label }}</span>
            </template>
          </ActionMenu>
          <IconButton
            :label="t('common.actions.close')"
            :disabled="busy"
            @click="close"
          >
            <X :size="18" aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <form class="resource-dialog-form" @submit.prevent="save">
        <label class="field-label">
          {{ t("common.fields.name") }}
          <TextInput
            v-model="name"
            :disabled="busy || !canEdit"
            required
            autocomplete="off"
          />
        </label>
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
            editingId === null ? [] : (environment?.variables ?? [])
          "
          :inherited-variables="
            editingId === null ? [] : (environment?.inheritedVariables ?? [])
          "
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
            {{ t("common.actions.cancel") }}
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
