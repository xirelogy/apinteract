<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Asterisk, Lock, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { defaultHeaderMergeMode } from "@/app/preferences/header-preferences";
import type {
  CollectionView,
  RequestField,
  VariableProfileView,
  VariablePreview,
  VariableWrite,
} from "@/model/contracts/backend";
import {
  createBlankHeaderField,
  editableRequestFields,
  ensureTrailingBlankRequestField,
  isBlankRequestField,
  meaningfulRequestFields,
} from "@/model/domain/request-fields";
import { collectTemplateVariableNames } from "@/model/domain/template-variables";
import ActionMenu, {
  type ActionMenuItem,
} from "@/view/presentation/controls/ActionMenu.vue";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import HeaderMergeModeToggle from "@/view/presentation/controls/HeaderMergeModeToggle.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import TemplateTextControl from "@/view/presentation/controls/TemplateTextControl.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import ResourceDeleteDialog from "./ResourceDeleteDialog.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";

interface VariableFieldsEditorApi {
  writes(): VariableWrite[];
}

const props = defineProps<{
  collection: CollectionView;
  variableProfile: VariableProfileView;
  variablePreviews: readonly VariablePreview[];
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  delete: [collectionId: string, revision: number];
  preview: [names: readonly string[]];
  save: [
    name: string,
    pathPrefix: string,
    headers: readonly RequestField[],
    variables: readonly VariableWrite[],
  ];
}>();
const { t } = useI18n();
const open = ref(true);
const activeSection = ref<"headers" | "variables">("headers");
const name = ref(props.collection.name);
const pathPrefix = ref(props.collection.pathPrefix);
const deleteConfirmationOpen = ref(false);
const headers = ref<RequestField[]>(
  editableRequestFields(
    props.collection.headers,
    props.canEdit,
    createBlankHeaderField,
  ),
);
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
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
      (header) => !header.enabled || header.name.trim() !== "",
    ),
);
const collectionActions = computed<readonly ActionMenuItem[]>(() => [
  {
    value: "delete",
    label: t("collection.deleteAction"),
    variant: "danger",
  },
]);

watch(previewSignature, scheduleVariablePreview, { immediate: true });

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

/** Requests closure through the shared controlled dialog lifecycle. */
function close(): void {
  deleteConfirmationOpen.value = false;
  open.value = false;
}

/** Opens styled confirmation before requesting collection deletion. */
function requestCollectionDeletion(): void {
  if (props.canEdit) deleteConfirmationOpen.value = true;
}

/** Routes one infrequent collection action from the header overflow menu. */
function selectCollectionAction(action: string): void {
  if (action === "delete") requestCollectionDeletion();
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
    pathPrefix.value,
    meaningfulRequestFields(headers.value),
    variableEditor.value?.writes() ?? [],
  );
}
</script>

<template>
  <DialogControl
    v-model:open="open"
    class="resource-dialog environment-dialog collection-properties-dialog"
    aria-labelledby="collection-properties-title"
    :busy="busy"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="collection-properties-title">
          {{ t("collection.propertiesTitle") }}
        </h2>
        <div class="resource-dialog-header-actions">
          <ActionMenu
            v-if="canEdit"
            :label="t('collection.moreActions', { name: collection.name })"
            :items="collectionActions"
            :disabled="busy"
            @select="selectCollectionAction"
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
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="t('collection.name')"
        >
          <TextInput
            :id="controlId"
            v-model="name"
            :aria-describedby="describedBy"
            :aria-label="t('collection.name')"
            :invalid="invalid"
            autocomplete="off"
            :disabled="busy || !canEdit"
          />
        </FormField>
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
            </TabsTrigger>
            <TabsTrigger class="tab-button" value="variables">
              {{ t("environment.variables") }}
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
              <div
                v-for="(header, index) in collection.inheritedHeaders"
                :key="`inherited-${index}`"
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
              <div
                v-for="(header, index) in headers"
                :key="index"
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
                  :aria-label="t('request.headerName', { index: index + 1 })"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="busy || !canEdit"
                  @input="updateHeaderName(index)"
                />
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
                    :aria-label="t('request.headerValue', { index: index + 1 })"
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
            </div>
          </TabsPanel>
          <TabsPanel value="variables" class="collection-properties-section">
            <VariableFieldsEditor
              ref="variableEditor"
              :profile-variables="variableProfile.variables"
              :can-edit="canEdit"
              :busy="busy"
            />
          </TabsPanel>
        </TabsRoot>
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
            variant="primary"
            type="submit"
            :disabled="busy || !canSave"
          >
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </form>
    </div>
  </DialogControl>

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
