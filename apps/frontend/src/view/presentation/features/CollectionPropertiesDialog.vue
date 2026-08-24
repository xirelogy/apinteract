<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Asterisk, Folder, Lock, FilePenLine, Save, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { defaultHeaderMergeMode } from "@/app/preferences/header-preferences";
import type {
  CollectionView,
  RequestField,
  VariableProfileView,
  VariablePreview,
  VariableWrite,
} from "@/model/contracts/backend";
import type { CollectionPropertiesDraft } from "@/model/domain/application";
import {
  createBlankHeaderField,
  editableRequestFields,
  ensureTrailingBlankRequestField,
  isBlankRequestField,
  meaningfulRequestFields,
} from "@/model/domain/request-fields";
import { collectTemplateVariableNames } from "@/model/domain/template-variables";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import HeaderMergeModeToggle from "@/view/presentation/controls/HeaderMergeModeToggle.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import TemplateTextControl from "@/view/presentation/controls/TemplateTextControl.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import ResourceDeleteDialog from "./ResourceDeleteDialog.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";
import DocumentationEditor from "./DocumentationEditor.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";

interface VariableFieldsEditorApi {
  writes(): VariableWrite[];
}

const props = defineProps<{
  collection: CollectionView;
  draft?: CollectionPropertiesDraft;
  variableProfile: VariableProfileView;
  variablePreviews: readonly VariablePreview[];
  canEdit: boolean;
  busy: boolean;
  recoveryWarning?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  change: [draft: CollectionPropertiesDraft];
  delete: [collectionId: string, revision: number];
  preview: [names: readonly string[]];
  save: [
    name: string,
    description: string,
    notes: string,
    pathPrefix: string,
    headers: readonly RequestField[],
    variables: readonly VariableWrite[],
  ];
}>();
const { t } = useI18n();
const activeSection = ref<"headers" | "variables" | "documentation">("headers");
const name = ref(props.draft?.name ?? props.collection.name);
const description = ref(
  props.draft?.description ?? props.collection.description,
);
const notes = ref(props.draft?.notes ?? props.collection.notes);
const pathPrefix = ref(props.draft?.pathPrefix ?? props.collection.pathPrefix);
const deleteConfirmationOpen = ref(false);
const headers = ref<RequestField[]>(
  editableRequestFields(
    props.draft?.headers ?? props.collection.headers,
    props.canEdit,
    createBlankHeaderField,
  ),
);
const expandedHeaderDescriptions = ref<RequestField[]>([]);
const expandedInheritedDescriptions = ref<RequestField[]>([]);
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
const variables = ref<readonly VariableWrite[]>(props.draft?.variables ?? []);
const headerCount = computed(
  () =>
    props.collection.inheritedHeaders.length +
    meaningfulRequestFields(headers.value).length,
);
const variableCount = ref(
  props.draft?.variables.length ?? props.variableProfile.variables.length,
);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
const displayedInheritedTarget = computed(() => {
  if (props.collection.inheritedTarget === "" || pathPrefix.value === "") {
    return props.collection.inheritedTarget;
  }
  if (pathPrefix.value.startsWith("/")) {
    return props.collection.inheritedTarget.replace(/\/+$/u, "");
  }
  return props.collection.inheritedTarget.endsWith("/")
    ? props.collection.inheritedTarget
    : `${props.collection.inheritedTarget}/`;
});
const inheritedTargetWidth = computed(
  () => `${Math.max(displayedInheritedTarget.value.length, 1) + 4}ch`,
);
const referencedVariableNames = computed(() =>
  collectTemplateVariableNames([
    props.collection.inheritedTarget,
    pathPrefix.value,
    ...props.collection.inheritedHeaders.map((header) => header.value),
    ...headers.value.map((header) => header.value),
  ]),
);
const previewSignature = computed(() =>
  referencedVariableNames.value.join("\0"),
);
const canSave = computed(
  () =>
    name.value.trim() !== "" &&
    meaningfulRequestFields(headers.value).every(
      (header) =>
        (!header.enabled || header.name.trim() !== "") &&
        ((header.description ?? "") === "" || header.name.trim() !== ""),
    ),
);
watch(previewSignature, scheduleVariablePreview, { immediate: true });
watch([name, description, notes, pathPrefix, headers], publishDraft, {
  deep: true,
});

onBeforeUnmount(() => {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
});

/** Debounces redacted variable previews while collection fields are edited. */
function scheduleVariablePreview(): void {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = undefined;
    emit("preview", [...referencedVariableNames.value]);
  }, 150);
}

/** Removes one common header by its visible ordered position. */
function removeHeader(index: number): void {
  headers.value.splice(index, 1);
  ensureTrailingBlankRequestField(headers.value, createBlankHeaderField);
}

/** Materializes the next common-header row after the trailing row is edited. */
function updateHeader(): void {
  ensureTrailingBlankRequestField(headers.value, createBlankHeaderField);
}

/** Toggles one local common-header description by row identity. */
function toggleHeaderDescription(header: RequestField): void {
  expandedHeaderDescriptions.value = expandedHeaderDescriptions.value.includes(
    header,
  )
    ? expandedHeaderDescriptions.value.filter(
        (candidate) => candidate !== header,
      )
    : [...expandedHeaderDescriptions.value, header];
}

/** Toggles one inherited common-header description without making it editable. */
function toggleInheritedDescription(header: RequestField): void {
  expandedInheritedDescriptions.value =
    expandedInheritedDescriptions.value.includes(header)
      ? expandedInheritedDescriptions.value.filter(
          (candidate) => candidate !== header,
        )
      : [...expandedInheritedDescriptions.value, header];
}

/** Applies the global default when a common header is given a new name. */
function updateHeaderName(index: number): void {
  const header = headers.value[index];
  if (header !== undefined) {
    header.mode = defaultHeaderMergeMode(header.name);
  }
  updateHeader();
}

/** Reports whether an enabled local override replaces this inherited pair. */
function isInheritedHeaderOverridden(inherited: RequestField): boolean {
  const name = inherited.name.toLowerCase();
  return headers.value.some(
    (header) =>
      header.enabled &&
      header.name.toLowerCase() === name &&
      (header.mode ?? "override") === "override",
  );
}

/** Moves one common header while preserving the trailing blank entry. */
function moveHeader(fromIndex: number, toIndex: number): void {
  const [header] = headers.value.splice(fromIndex, 1);
  if (header !== undefined) headers.value.splice(toIndex, 0, header);
  ensureTrailingBlankRequestField(headers.value, createBlankHeaderField);
}

const headerReorder = useRowReorder({
  canMove: (index) =>
    headers.value[index] !== undefined &&
    !isBlankRequestField(headers.value[index]),
  move: moveHeader,
  isDisabled: () => props.busy || !props.canEdit,
});

/** Publishes tab-owned editable state for dirty tracking and local recovery. */
function publishDraft(): void {
  emit("change", {
    name: name.value,
    description: description.value,
    notes: notes.value,
    pathPrefix: pathPrefix.value,
    headers: meaningfulRequestFields(headers.value),
    variables: variables.value,
  });
}

/** Publishes variable edits with the rest of the collection draft. */
function updateVariables(nextVariables: readonly VariableWrite[]): void {
  variables.value = nextVariables;
  publishDraft();
}

/** Opens styled confirmation before requesting collection deletion. */
function requestCollectionDeletion(): void {
  if (props.canEdit) deleteConfirmationOpen.value = true;
}

/** Emits the immutable collection deletion target after confirmation. */
function confirmCollectionDeletion(): void {
  emit("delete", props.collection.collectionId, props.collection.revision);
}

/** Emits all editable collection properties as one user operation. */
function save(): void {
  if (!props.canEdit || !canSave.value) {
    return;
  }
  emit(
    "save",
    name.value.trim(),
    description.value,
    notes.value,
    pathPrefix.value,
    meaningfulRequestFields(headers.value),
    variableEditor.value?.writes() ?? [],
  );
}
</script>

<template>
  <section
    id="request-workbench"
    class="resource-editor-panel collection-properties-dialog"
    aria-labelledby="collection-properties-title"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header resource-editor-header">
        <div class="resource-editor-title">
          <Folder
            class="resource-editor-kind-icon"
            :size="19"
            aria-hidden="true"
          />
          <TextInput
            id="collection-properties-title"
            v-model="name"
            class="request-name-input"
            :aria-label="t('collection.name')"
            :placeholder="t('collection.propertiesTitle')"
            autocomplete="off"
            :disabled="busy || !canEdit"
          />
        </div>
        <div class="command-bar resource-editor-actions">
          <ButtonControl
            v-if="canEdit"
            type="submit"
            form="collection-properties-form"
            variant="primary"
            :aria-label="t('common.actions.save')"
            :title="t('common.actions.save')"
            :disabled="busy || !canSave"
          >
            <template #leading>
              <Save :size="16" aria-hidden="true" />
            </template>
            {{ t("common.actions.save") }}
          </ButtonControl>
          <ButtonControl
            v-if="canEdit"
            variant="danger-outline"
            :aria-label="t('common.actions.delete')"
            :title="t('common.actions.delete')"
            :disabled="busy"
            @click="requestCollectionDeletion"
          >
            <template #leading>
              <Trash2 :size="16" aria-hidden="true" />
            </template>
            {{ t("common.actions.delete") }}
          </ButtonControl>
        </div>
      </header>
      <p
        v-if="recoveryWarning"
        class="resource-editor-recovery-warning"
        role="status"
      >
        {{ t("request.recovery.secrets-omitted") }}
      </p>
      <form
        id="collection-properties-form"
        class="resource-dialog-form"
        @submit.prevent="save"
      >
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="t('collection.pathPrefix')"
        >
          <div class="composed-target-inputs">
            <TemplateTextControl
              :model-value="displayedInheritedTarget"
              class="inherited-target-input"
              :style="{ width: inheritedTargetWidth }"
              font="mono"
              :previews="variablePreviews"
              :aria-label="t('request.inheritedTarget')"
              readonly
              autocomplete="off"
              spellcheck="false"
            />
            <TemplateTextControl
              :id="controlId"
              v-model="pathPrefix"
              :previews="variablePreviews"
              :aria-describedby="describedBy"
              :aria-label="t('collection.pathPrefix')"
              :placeholder="
                collection.inheritedTarget === ''
                  ? t('request.targetUrlPlaceholder')
                  : t('request.requestPathPlaceholder')
              "
              :invalid="invalid"
              font="mono"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy || !canEdit"
            />
          </div>
        </FormField>
        <TabsRoot v-model="activeSection" class="collection-properties-tabs">
          <TabsList
            class="request-tabs"
            :label="t('collection.propertiesTitle')"
          >
            <TabsTrigger class="tab-button" value="headers">
              {{ t("collection.commonHeaders") }}
              <span class="tab-count">{{ headerCount }}</span>
            </TabsTrigger>
            <TabsTrigger class="tab-button" value="variables">
              {{ t("environment.variables") }}
              <span class="tab-count">{{ variableCount }}</span>
            </TabsTrigger>
            <TabsTrigger class="tab-button" value="documentation">
              {{ t("documentation.title") }}
              <span
                v-if="description.trim() !== '' || notes.trim() !== ''"
                class="tab-content-indicator"
                :title="t('request.hasContent')"
              ></span>
            </TabsTrigger>
          </TabsList>
          <TabsPanel value="headers" class="collection-properties-section">
            <div class="collection-header-fields">
              <div class="request-field-heading" aria-hidden="true">
                <span></span>
                <span>{{ t("common.fields.name") }}</span>
                <span>{{ t("common.fields.value") }}</span>
                <span></span>
              </div>
              <template
                v-for="(header, index) in collection.inheritedHeaders"
                :key="`inherited-${index}`"
              >
                <div
                  class="request-field-row inherited-header-row"
                  :class="{
                    'is-header-overridden': isInheritedHeaderOverridden(header),
                  }"
                >
                  <CheckboxControl
                    :model-value="header.enabled"
                    visually-hidden-label
                    :label="
                      t('request.inheritedHeaderEnabled', { index: index + 1 })
                    "
                    disabled
                  />
                  <div class="field-key-cell">
                    <TextInput
                      :model-value="header.name"
                      class="field-cell-input"
                      density="compact"
                      font="mono"
                      :aria-label="
                        t('request.inheritedHeaderName', { index: index + 1 })
                      "
                      disabled
                    />
                    <IconButton
                      size="compact"
                      class="field-description-action"
                      :class="{
                        'has-content': header.description?.trim() !== '',
                      }"
                      :label="t('documentation.viewFieldDescription')"
                      :disabled="header.description?.trim() === ''"
                      @click="toggleInheritedDescription(header)"
                    >
                      <FilePenLine :size="15" aria-hidden="true" />
                    </IconButton>
                  </div>
                  <div class="header-value-field">
                    <HeaderMergeModeToggle
                      :model-value="header.mode ?? 'override'"
                      readonly
                    />
                    <TemplateTextControl
                      :model-value="header.value"
                      class="field-template-input"
                      density="compact"
                      font="mono"
                      :previews="variablePreviews"
                      :aria-label="
                        t('request.inheritedHeaderValue', { index: index + 1 })
                      "
                      readonly
                    />
                  </div>
                  <div class="row-actions">
                    <span
                      class="inherited-header-indicator"
                      role="img"
                      :aria-label="
                        isInheritedHeaderOverridden(header)
                          ? t('request.inheritedHeaderOverridden')
                          : t('request.inherited')
                      "
                      :title="
                        isInheritedHeaderOverridden(header)
                          ? t('request.inheritedHeaderOverridden')
                          : t('request.inherited')
                      "
                    >
                      <Lock :size="14" aria-hidden="true" />
                    </span>
                  </div>
                </div>
                <div
                  v-if="expandedInheritedDescriptions.includes(header)"
                  class="field-description-row inherited-field-description"
                  :class="{
                    'is-header-overridden': isInheritedHeaderOverridden(header),
                  }"
                >
                  <TextInput
                    :model-value="header.description ?? ''"
                    :aria-label="t('documentation.fieldDescription')"
                    :placeholder="t('documentation.fieldDescription')"
                    disabled
                  />
                </div>
              </template>
              <template v-for="(header, index) in headers" :key="index">
                <div
                  class="request-field-row"
                  :class="headerReorder.classes(index)"
                  @dragover.stop="headerReorder.updateDropTarget($event, index)"
                  @drop.stop="headerReorder.finishDrop($event)"
                >
                  <CheckboxControl
                    v-model="header.enabled"
                    visually-hidden-label
                    :label="
                      t('request.enableField', {
                        kind: t('request.headerField'),
                        index: index + 1,
                      })
                    "
                    :disabled="busy || !canEdit"
                  />
                  <div class="field-key-cell">
                    <TextInput
                      v-model="header.name"
                      class="field-cell-input"
                      density="compact"
                      font="mono"
                      :placeholder="
                        isBlankRequestField(header)
                          ? t('collection.addHeader')
                          : t('common.fields.name')
                      "
                      :aria-label="
                        t('request.headerName', { index: index + 1 })
                      "
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="busy || !canEdit"
                      @input="updateHeaderName(index)"
                    />
                    <IconButton
                      class="field-description-action"
                      size="compact"
                      :class="{
                        'has-content': header.description?.trim() !== '',
                      }"
                      :label="t('documentation.editFieldDescription')"
                      :disabled="
                        busy || !canEdit || isBlankRequestField(header)
                      "
                      @click="toggleHeaderDescription(header)"
                    >
                      <FilePenLine :size="15" aria-hidden="true" />
                    </IconButton>
                  </div>
                  <div class="header-value-field">
                    <HeaderMergeModeToggle
                      :model-value="header.mode ?? 'override'"
                      :disabled="busy || !canEdit"
                      @update:model-value="header.mode = $event"
                    />
                    <TemplateTextControl
                      v-model="header.value"
                      class="field-template-input"
                      density="compact"
                      font="mono"
                      :previews="variablePreviews"
                      :aria-label="
                        t('request.headerValue', { index: index + 1 })
                      "
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="busy || !canEdit"
                      @input="updateHeader"
                    />
                  </div>
                  <div class="row-actions">
                    <RowReorderHandle
                      v-if="!isBlankRequestField(header)"
                      :label="
                        t('common.actions.reorderRow', {
                          item: t('request.headerField'),
                          index: index + 1,
                        })
                      "
                      :disabled="busy || !canEdit"
                      @drag-start="headerReorder.startDrag($event, index)"
                      @drag-end="headerReorder.cancelDrag"
                      @move="headerReorder.moveByKeyboard(index, $event)"
                    />
                    <IconButton
                      v-if="canEdit && !isBlankRequestField(header)"
                      size="compact"
                      :label="
                        t('request.removeField', {
                          kind: t('request.headerField'),
                          index: index + 1,
                        })
                      "
                      :disabled="busy"
                      @click="removeHeader(index)"
                    >
                      <Trash2 :size="15" aria-hidden="true" />
                    </IconButton>
                    <span v-else class="new-row-marker" aria-hidden="true">
                      <Asterisk :size="15" />
                    </span>
                  </div>
                </div>
                <div
                  v-if="expandedHeaderDescriptions.includes(header)"
                  class="field-description-row"
                >
                  <TextInput
                    :model-value="header.description ?? ''"
                    :aria-label="t('documentation.fieldDescription')"
                    :placeholder="
                      t('documentation.fieldDescriptionPlaceholder')
                    "
                    :maxlength="4096"
                    :disabled="busy || !canEdit"
                    @update:model-value="header.description = $event"
                    @input="publishDraft"
                  />
                </div>
              </template>
            </div>
          </TabsPanel>
          <TabsPanel value="variables" class="collection-properties-section">
            <VariableFieldsEditor
              ref="variableEditor"
              :profile-variables="variableProfile.variables"
              :draft-variables="draft?.variables"
              :inherited-variables="variableProfile.inheritedVariables"
              :can-edit="canEdit"
              :busy="busy"
              @count-change="variableCount = $event"
              @change="updateVariables"
            />
          </TabsPanel>
          <TabsPanel
            value="documentation"
            class="collection-properties-section"
          >
            <DocumentationEditor
              v-model:description="description"
              v-model:notes="notes"
              :disabled="busy || !canEdit"
            />
          </TabsPanel>
        </TabsRoot>
      </form>
    </div>
  </section>

  <ResourceDeleteDialog
    class="collection-delete-dialog"
    :open="deleteConfirmationOpen"
    title-id="collection-delete-dialog-title"
    :title="t('collection.deleteTitle')"
    :message="t('collection.deleteMessage', { name: collection.name })"
    :additional-message="t('collection.deleteUnsavedChanges')"
    :confirm-label="t('collection.deleteAction')"
    :busy="busy"
    @update:open="deleteConfirmationOpen = $event"
    @confirm="confirmCollectionDeletion"
  />
</template>
