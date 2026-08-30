<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { v7 as uuidV7 } from "uuid";
import { useI18n } from "vue-i18n";
import type {
  RequestBodyHostKind,
  RequestContentFormatResult,
} from "@apinteract/plugin-api/frontend";

import type {
  MultipartFileField,
  RequestAttachment,
  RequestBodyDefinition,
  RequestField,
  VariablePreview,
} from "@/model/contracts/backend";
import CodeEditor, {
  type CodeEditorLanguage,
} from "@/view/presentation/controls/CodeEditor.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import FormValueTypeToggle, {
  type FormValueType,
} from "@/view/presentation/controls/FormValueTypeToggle.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import TemplateTextControl from "@/view/presentation/controls/TemplateTextControl.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";
import { Asterisk, FilePenLine, Trash2 } from "@lucide/vue";

interface PendingFileField {
  readonly kind: "pending-file";
  name: string;
  enabled: boolean;
  description?: string;
  readonly textValue: string;
}

type EditableFormField = RequestField | MultipartFileField | PendingFileField;

const props = defineProps<{
  body: RequestBodyDefinition;
  wireKind: RequestBodyHostKind;
  label: string;
  disabled: boolean;
  variablePreviews: readonly VariablePreview[];
  uploadAttachment: ((file: File) => Promise<RequestAttachment>) | null;
  codeLanguage: CodeEditorLanguage;
  contentTypePlaceholder: string;
  format?: (source: string) => RequestContentFormatResult;
}>();
const emit = defineEmits<{ change: [body: RequestBodyDefinition] }>();
const { t } = useI18n();
const current = ref<RequestBodyDefinition>(cloneBody(props.body));
const formFields = ref<EditableFormField[]>(editableFields(props.body));
const fileInput = ref<HTMLInputElement | null>(null);
const attachmentInput = ref<HTMLInputElement | null>(null);
const attachmentTargetIndex = ref<number | null>(null);
const uploading = ref(false);
const formatError = ref("");
const expandedDescriptions = ref<number[]>([]);

watch(
  () => props.body,
  (body) => {
    current.value = cloneBody(body);
    formFields.value = editableFields(body);
  },
  { deep: true },
);

const bodyKind = computed(() => props.wireKind);
const contentType = computed({
  get: () =>
    current.value.kind === "none" ? "" : (current.value.contentType ?? ""),
  set: (value: string) => {
    if (current.value.kind === "none") return;
    current.value = { ...current.value, contentType: value.trim() || null };
    publish();
  },
});

/** Publishes an immutable canonical body after one interactive edit. */
function publish(): void {
  if (current.value.kind === "urlencoded") {
    current.value = {
      ...current.value,
      fields: meaningfulTextFields(),
    };
  } else if (current.value.kind === "multipart") {
    current.value = {
      ...current.value,
      fields: meaningfulMultipartFields(),
    };
  }
  emit("change", cloneBody(current.value));
}

/** Applies text edits without retaining stale formatter feedback. */
function updateText(value: string): void {
  if (current.value.kind !== "text") return;
  formatError.value = "";
  current.value = { ...current.value, text: value };
  publish();
}

/** Runs the plugin-owned formatter over the current canonical text body. */
function formatText(): void {
  if (current.value.kind !== "text" || props.format === undefined) return;
  const result = props.format(current.value.text);
  if (!result.valid) {
    formatError.value = result.error;
    return;
  }
  formatError.value = "";
  current.value = { ...current.value, text: result.value };
  publish();
}

/** Opens the complete-body attachment picker. */
function chooseBodyFile(): void {
  fileInput.value?.click();
}

/** Uploads a complete binary body through the host-owned attachment service. */
async function attachBodyFile(event: Event): Promise<void> {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || props.uploadAttachment === null)
    return;
  const file = input.files?.[0];
  input.value = "";
  if (file === undefined) return;
  uploading.value = true;
  try {
    const attachment = await props.uploadAttachment(file);
    current.value = { kind: "file", contentType: null, attachment };
    publish();
  } finally {
    uploading.value = false;
  }
}

/** Creates a stable multipart boundary for a newly selected wire body. */
function createBoundary(): string {
  return `----APInteractBoundary${uuidV7().replaceAll("-", "")}`;
}

/** Adds a trailing text row used only by the editor surface. */
function ensureTrailingBlank(): void {
  if (formFields.value.length === 0 || !isBlank(formFields.value.at(-1)!)) {
    formFields.value.push({ name: "", value: "", enabled: true });
  }
}

/** Publishes a form edit after maintaining its presentation-only blank row. */
function updateForm(): void {
  ensureTrailingBlank();
  publish();
}

/** Toggles the editable description row for one form field. */
function toggleFieldDescription(index: number): void {
  expandedDescriptions.value = expandedDescriptions.value.includes(index)
    ? expandedDescriptions.value.filter((candidate) => candidate !== index)
    : [...expandedDescriptions.value, index];
}

/** Moves one persisted form field while retaining the presentation-only blank row. */
function moveFormField(fromIndex: number, toIndex: number): void {
  const [field] = formFields.value.splice(fromIndex, 1);
  if (field !== undefined) formFields.value.splice(toIndex, 0, field);
  ensureTrailingBlank();
  publish();
}

const formFieldReorder = useRowReorder({
  canMove: (index) => {
    const field = formFields.value[index];
    return field !== undefined && !isBlank(field);
  },
  move: moveFormField,
  isDisabled: () => props.disabled,
});

/** Removes one form field without retaining an empty persisted row. */
function removeFormField(index: number): void {
  formFields.value.splice(index, 1);
  ensureTrailingBlank();
  publish();
}

/** Switches a multipart field between text and pending-file values. */
function selectValueType(index: number, type: FormValueType): void {
  const field = formFields.value[index];
  if (field === undefined) return;
  if (type === "file" && !isFileValue(field)) {
    formFields.value.splice(index, 1, {
      kind: "pending-file",
      name: field.name,
      enabled: field.enabled,
      ...(field.description === undefined
        ? {}
        : { description: field.description }),
      textValue: field.value,
    });
    ensureTrailingBlank();
    return;
  }
  if (type === "text" && isFileValue(field)) {
    formFields.value.splice(index, 1, {
      name: field.name,
      value: isPendingFile(field) ? field.textValue : "",
      enabled: field.enabled,
      ...(field.description === undefined
        ? {}
        : { description: field.description }),
    });
    updateForm();
  }
}

/** Opens the attachment picker for one multipart row. */
function chooseAttachment(index: number): void {
  attachmentTargetIndex.value = index;
  attachmentInput.value?.click();
}

/** Uploads one multipart file and assigns it to its targeted row. */
async function attachMultipartFile(event: Event): Promise<void> {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || props.uploadAttachment === null)
    return;
  const file = input.files?.[0];
  const index = attachmentTargetIndex.value;
  input.value = "";
  attachmentTargetIndex.value = null;
  if (file === undefined || index === null) return;
  const field = formFields.value[index];
  if (field === undefined) return;
  uploading.value = true;
  try {
    const attachment = await props.uploadAttachment(file);
    formFields.value.splice(index, 1, {
      kind: "file",
      name: field.name,
      enabled: field.enabled,
      ...(field.description === undefined
        ? {}
        : { description: field.description }),
      attachment,
    });
    updateForm();
  } finally {
    uploading.value = false;
  }
}

/** Returns persisted URL-encoded rows without file or blank values. */
function meaningfulTextFields(): RequestField[] {
  return formFields.value.flatMap((field) =>
    isFileValue(field) || isBlank(field) ? [] : [{ ...field }],
  );
}

/** Returns persisted multipart text and file rows without editor placeholders. */
function meaningfulMultipartFields(): (RequestField | MultipartFileField)[] {
  return formFields.value.flatMap((field) => {
    if (isBlank(field) || isPendingFile(field)) return [];
    return [
      isFileField(field)
        ? { ...field, attachment: { ...field.attachment } }
        : { ...field },
    ];
  });
}

/** Reports whether a form row contains no persistable value. */
function isBlank(field: EditableFormField): boolean {
  return !isFileValue(field) && field.name.trim() === "" && field.value === "";
}

/** Narrows one persisted multipart file field. */
function isFileField(field: EditableFormField): field is MultipartFileField {
  return "kind" in field && field.kind === "file";
}

/** Narrows one presentation-only pending file field. */
function isPendingFile(field: EditableFormField): field is PendingFileField {
  return "kind" in field && field.kind === "pending-file";
}

/** Reports whether a multipart row uses either file representation. */
function isFileValue(
  field: EditableFormField,
): field is MultipartFileField | PendingFileField {
  return isFileField(field) || isPendingFile(field);
}

/** Creates editable rows from one canonical form body. */
function editableFields(body: RequestBodyDefinition): EditableFormField[] {
  const fields =
    body.kind === "urlencoded" || body.kind === "multipart"
      ? body.fields.map((field) =>
          "kind" in field && field.kind === "file"
            ? { ...field, attachment: { ...field.attachment } }
            : { ...field },
        )
      : [];
  if (fields.length === 0 || !isBlank(fields.at(-1)!)) {
    fields.push({ name: "", value: "", enabled: true });
  }
  return fields;
}

/** Deep-copies the canonical request body at plugin lifecycle boundaries. */
function cloneBody(body: RequestBodyDefinition): RequestBodyDefinition {
  if (body.kind === "file")
    return { ...body, attachment: { ...body.attachment } };
  if (body.kind === "urlencoded")
    return { ...body, fields: body.fields.map((field) => ({ ...field })) };
  if (body.kind === "multipart") {
    return {
      ...body,
      boundary: body.boundary || createBoundary(),
      fields: body.fields.map((field) =>
        "kind" in field && field.kind === "file"
          ? { ...field, attachment: { ...field.attachment } }
          : { ...field },
      ),
    };
  }
  return { ...body };
}

/** Formats attachment sizes without exposing storage implementation details. */
function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}
</script>

<template>
  <div class="wire-request-body-editor">
    <div v-if="bodyKind !== 'none'" class="request-body-controls">
      <TextInput
        v-model="contentType"
        class="body-content-type-input"
        density="compact"
        font="mono"
        :aria-label="t('request.contentTypeOverride')"
        :placeholder="
          bodyKind === 'file' && current.kind === 'file'
            ? current.attachment.contentType
            : contentTypePlaceholder
        "
        :disabled="disabled"
      />
      <ButtonControl
        v-if="bodyKind === 'text' && format !== undefined"
        size="compact"
        variant="secondary"
        :disabled="disabled"
        @click="formatText"
      >
        {{ t("request.formatBody") }}
      </ButtonControl>
    </div>
    <div class="wire-request-body-content">
      <p
        v-if="formatError !== ''"
        class="request-body-format-error"
        role="status"
      >
        {{ formatError }}
      </p>
      <p v-if="bodyKind === 'none'" class="request-body-empty">
        {{ t("request.noBodyDescription") }}
      </p>
      <CodeEditor
        v-else-if="bodyKind === 'text' && current.kind === 'text'"
        class="body-code-editor"
        :model-value="current.text"
        :language="codeLanguage"
        :label="label"
        :disabled="disabled"
        @update:model-value="updateText"
      />
      <div v-else-if="bodyKind === 'file'" class="request-body-file">
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          :disabled="disabled || uploading || uploadAttachment === null"
          @change="attachBodyFile"
        />
        <ButtonControl
          v-if="current.kind !== 'file'"
          size="compact"
          variant="secondary"
          :disabled="disabled || uploading || uploadAttachment === null"
          @click="chooseBodyFile"
        >
          {{ t("request.chooseBodyFile") }}
        </ButtonControl>
        <button
          v-else-if="current.kind === 'file'"
          type="button"
          class="request-file-part"
          :disabled="disabled || uploading"
          @click="chooseBodyFile"
        >
          <span class="request-file-name">{{
            current.attachment.fileName
          }}</span>
          <span class="request-file-metadata">
            {{ current.attachment.contentType }} ·
            {{ attachmentSize(current.attachment.byteLength) }}
          </span>
        </button>
      </div>
      <div
        v-else-if="bodyKind === 'urlencoded' || bodyKind === 'multipart'"
        class="request-form-fields"
      >
        <input
          v-if="bodyKind === 'multipart'"
          ref="attachmentInput"
          class="visually-hidden"
          type="file"
          :disabled="disabled || uploading || uploadAttachment === null"
          @change="attachMultipartFile"
        />
        <template v-for="(field, index) in formFields" :key="index">
          <div
            class="request-field-row"
            :class="formFieldReorder.classes(index)"
            @dragover.stop="formFieldReorder.updateDropTarget($event, index)"
            @drop.stop="formFieldReorder.finishDrop($event)"
          >
            <CheckboxControl
              v-model="field.enabled"
              visually-hidden-label
              :label="
                t('request.enableField', {
                  kind: t('request.formField'),
                  index: index + 1,
                })
              "
              :disabled="disabled"
              @change="updateForm"
            />
            <div class="field-key-cell">
              <TemplateTextControl
                v-model="field.name"
                class="field-template-input"
                density="compact"
                font="mono"
                :previews="variablePreviews"
                :aria-label="t('request.formName', { index: index + 1 })"
                :placeholder="
                  isBlank(field)
                    ? t('request.addFormField')
                    : t('common.fields.name')
                "
                :disabled="disabled"
                @input="updateForm"
              />
              <IconButton
                class="field-description-action"
                size="compact"
                :class="{ 'has-content': field.description?.trim() !== '' }"
                :label="t('documentation.editFieldDescription')"
                :disabled="disabled || isBlank(field)"
                @click="toggleFieldDescription(index)"
              >
                <FilePenLine :size="15" aria-hidden="true" />
              </IconButton>
            </div>
            <div
              class="form-value-field"
              :class="{ 'has-value-type-toggle': bodyKind === 'multipart' }"
            >
              <FormValueTypeToggle
                v-if="bodyKind === 'multipart'"
                :model-value="isFileValue(field) ? 'file' : 'text'"
                :disabled="disabled || uploadAttachment === null"
                @update:model-value="selectValueType(index, $event)"
              />
              <TemplateTextControl
                v-if="!isFileValue(field)"
                v-model="field.value"
                density="compact"
                font="mono"
                :previews="variablePreviews"
                :aria-label="t('request.formValue', { index: index + 1 })"
                :placeholder="t('common.fields.value')"
                :disabled="disabled"
                @input="updateForm"
              />
              <button
                v-else-if="isPendingFile(field)"
                type="button"
                class="request-file-part request-file-part-empty"
                :disabled="disabled || uploading"
                @click="chooseAttachment(index)"
              >
                {{ t("request.attachFile") }}
              </button>
              <button
                v-else
                type="button"
                class="request-file-part"
                :disabled="disabled || uploading"
                @click="chooseAttachment(index)"
              >
                <span class="request-file-name">{{
                  field.attachment.fileName
                }}</span>
                <span class="request-file-metadata">
                  {{ field.attachment.contentType }} ·
                  {{ attachmentSize(field.attachment.byteLength) }}
                </span>
              </button>
            </div>
            <div class="row-actions">
              <RowReorderHandle
                v-if="!isBlank(field)"
                :label="
                  t('common.actions.reorderRow', {
                    item: t('request.formField'),
                    index: index + 1,
                  })
                "
                :disabled="disabled"
                @drag-start="formFieldReorder.startDrag($event, index)"
                @drag-end="formFieldReorder.cancelDrag"
                @move="formFieldReorder.moveByKeyboard(index, $event)"
              />
              <IconButton
                v-if="!isBlank(field)"
                class="compact-icon-button"
                size="compact"
                :label="
                  t('request.removeField', {
                    kind: t('request.formField'),
                    index: index + 1,
                  })
                "
                :title="
                  t('request.removeFieldTitle', {
                    kind: t('request.formField'),
                  })
                "
                :disabled="disabled"
                @click="removeFormField(index)"
              >
                <Trash2 :size="15" aria-hidden="true" />
              </IconButton>
              <span v-else class="new-row-marker" aria-hidden="true">
                <Asterisk :size="15" />
              </span>
            </div>
          </div>
          <div
            v-if="expandedDescriptions.includes(index) && !isBlank(field)"
            class="field-description-row"
          >
            <TextInput
              :model-value="field.description ?? ''"
              :aria-label="t('documentation.fieldDescription')"
              :placeholder="t('documentation.fieldDescriptionPlaceholder')"
              :maxlength="4096"
              :disabled="disabled"
              @update:model-value="field.description = $event"
              @input="updateForm"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
