<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  Asterisk,
  Globe2,
  History,
  Lock,
  Play,
  Route,
  Save,
  Trash2,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { defaultHeaderMergeMode } from "@/app/preferences/header-preferences";
import type {
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestRevisionSummary,
  RequestRevisionView,
  RequestView,
  VariableProfileView,
  VariablePreview,
  VariableWrite,
} from "@/model/contracts/backend";
import type { RequestDraftInput } from "@/model/domain/application";
import {
  createBlankHeaderField,
  editableRequestFields,
  ensureTrailingBlankRequestField,
  isBlankRequestField,
  meaningfulRequestFields,
} from "@/model/domain/request-fields";
import { collectTemplateVariableNames } from "@/model/domain/template-variables";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import InlineWarning from "@/view/presentation/controls/InlineWarning.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import HeaderMergeModeToggle from "@/view/presentation/controls/HeaderMergeModeToggle.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TemplateTextControl from "@/view/presentation/controls/TemplateTextControl.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";
import ResponsePanel from "./ResponsePanel.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";

interface VariableFieldsEditorApi {
  writes(): VariableWrite[];
}

const ScriptEditor = defineAsyncComponent(
  () => import("@/view/presentation/controls/ScriptEditor.vue"),
);

const props = withDefaults(
  defineProps<{
    request: RequestView | null;
    draft: RequestDraftInput | null;
    execution: ExecutionView | null;
    tabId: string | null;
    temporary: boolean;
    inheritedTarget?: string;
    inheritedHeaders: readonly RequestField[];
    requestVariableProfile?: VariableProfileView | null;
    variablePreviews?: readonly VariablePreview[];
    previewContextKey?: string | null;
    busy: boolean;
    canEdit?: boolean;
    revisions?: readonly RequestRevisionSummary[];
    viewingRevision?: RequestRevisionView | null;
  }>(),
  {
    inheritedTarget: "",
    variablePreviews: () => [],
    requestVariableProfile: null,
    previewContextKey: null,
    canEdit: true,
    revisions: () => [],
    viewingRevision: null,
  },
);
const { t } = useI18n();

const emit = defineEmits<{
  save: [draft: RequestDraftInput];
  execute: [draft: RequestDraftInput];
  change: [draft: RequestDraftInput];
  download: [executionId: string];
  preview: [names: readonly string[]];
  loadVariables: [];
  saveVariables: [variables: readonly VariableWrite[]];
  loadRevisions: [];
  selectRevision: [revisionId: string | null];
  nameRevision: [revisionId: string, name: string | null];
  restoreRevision: [revisionId: string];
  executeRevision: [revisionId: string];
}>();

const methods: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
const methodOptions = methods.map((option) => ({
  value: option,
  label: option,
}));
const targetModeOptions = computed(() => [
  { value: "composed", label: t("request.targetModes.composed") },
  { value: "absolute", label: t("request.targetModes.absolute") },
]);
const requestTabs = [
  "query",
  "headers",
  "body",
  "preRequest",
  "postResponse",
  "variables",
  "versions",
] as const;
const name = ref("");
const method = ref<HttpMethod>("GET");
const targetMode = ref<"absolute" | "composed">("composed");
const targetUrl = ref("");
const query = ref<RequestField[]>([]);
const headers = ref<RequestField[]>([]);
const body = ref("");
const preRequestScript = ref("");
const postResponseScript = ref("");
const activeTab = ref<(typeof requestTabs)[number]>("query");
const versionName = ref("");
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
const requestVariableCount = ref<number | null>(null);
const workbench = ref<HTMLElement | null>(null);
const requestPanePercent = ref(44);
const resizingPointerId = ref<number | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const paneStyle = computed(() => ({
  "--request-editor-share": `${requestPanePercent.value}%`,
}));

watch(
  [() => props.draft, () => props.viewingRevision],
  ([draft, revision]) => {
    const source = revision?.request ?? draft;
    name.value = source?.name ?? "";
    method.value = source?.method ?? "GET";
    targetMode.value = source?.targetMode ?? "composed";
    targetUrl.value = source?.targetUrl ?? "";
    query.value = editableRequestFields(source?.query ?? [], true);
    headers.value = editableRequestFields(
      source?.headers ?? [],
      true,
      createBlankHeaderField,
    );
    body.value = source?.body ?? "";
    preRequestScript.value = source?.preRequestScript ?? "";
    postResponseScript.value = source?.postResponseScript ?? "";
  },
  { immediate: true },
);
watch(
  () => props.viewingRevision,
  (revision) => {
    versionName.value = revision?.name ?? "";
  },
  { immediate: true },
);

watch(
  () => props.requestVariableProfile,
  (profile) => {
    requestVariableCount.value = profile?.variables.length ?? null;
  },
  { immediate: true },
);
const validTarget = computed(() =>
  targetMode.value === "composed"
    ? isValidPathTemplate(targetUrl.value) &&
      isValidComposedPrefix(props.inheritedTarget)
    : isValidTargetTemplate(targetUrl.value),
);
const displayedInheritedTarget = computed(() => {
  if (props.inheritedTarget === "" || targetUrl.value === "") {
    return props.inheritedTarget;
  }
  if (targetUrl.value.startsWith("/")) {
    return props.inheritedTarget.replace(/\/+$/u, "");
  }
  return props.inheritedTarget.endsWith("/")
    ? props.inheritedTarget
    : `${props.inheritedTarget}/`;
});
const inheritedTargetWidth = computed(
  () => `${Math.max(displayedInheritedTarget.value.length, 1) + 4}ch`,
);
const queryCount = computed(() => meaningfulRequestFields(query.value).length);
const headerCount = computed(
  () =>
    meaningfulRequestFields(headers.value).length +
    props.inheritedHeaders.length,
);
const overriddenInheritedHeaderNames = computed(() => {
  const names = new Set<string>();
  for (const header of meaningfulRequestFields(headers.value)) {
    if (header.enabled && (header.mode ?? "override") === "override") {
      names.add(header.name.toLowerCase());
    }
  }
  return names;
});
const referencedVariableNames = computed(() =>
  collectTemplateVariableNames([
    ...(targetMode.value === "composed" ? [props.inheritedTarget] : []),
    targetUrl.value,
    ...query.value.map((field) => field.value),
    ...headers.value.map((field) => field.value),
    ...props.inheritedHeaders.map((field) => field.value),
    body.value,
  ]),
);
const previewSignature = computed(() =>
  referencedVariableNames.value.join("\0"),
);

watch(
  [previewSignature, () => props.previewContextKey],
  scheduleVariablePreview,
  { immediate: true },
);

watch(
  [
    activeTab,
    () => props.request?.requestId,
    () => props.requestVariableProfile?.scopeId,
  ],
  ([tab, requestId, profileScopeId]) => {
    if (
      tab === "variables" &&
      requestId !== undefined &&
      profileScopeId !== requestId
    ) {
      emit("loadVariables");
    } else if (tab === "versions" && requestId !== undefined) {
      emit("loadRevisions");
    }
  },
);

onBeforeUnmount(() => {
  if (previewTimer !== undefined) {
    clearTimeout(previewTimer);
  }
});

/** Accepts final HTTP URLs and bounded placeholders resolved by the backend. */
function isValidTargetTemplate(value: string): boolean {
  if (value.includes("<<")) {
    return value.length <= 8192 && !value.includes("?") && !value.includes("#");
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Requires an inherited chain to begin with a literal or variable URL base. */
function isValidComposedPrefix(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("<<")
  );
}

/** Accepts path-only composed target templates before backend interpolation. */
function isValidPathTemplate(value: string): boolean {
  return (
    value.length <= 8192 &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !value.startsWith("//")
  );
}

/** Debounces metadata lookup while preserving uninterrupted request editing. */
function scheduleVariablePreview(): void {
  if (previewTimer !== undefined) {
    clearTimeout(previewTimer);
  }
  previewTimer = setTimeout(() => {
    previewTimer = undefined;
    emit("preview", [...referencedVariableNames.value]);
  }, 150);
}
const canSave = computed(
  () =>
    props.viewingRevision === null &&
    validTarget.value &&
    (props.temporary || name.value.trim() !== ""),
);
const editorDisabled = computed(
  () => props.busy || props.viewingRevision !== null,
);
const draftRevisionLabel = computed(() =>
  props.temporary
    ? t("request.temporary")
    : t("request.draft", { revision: props.request?.draftRevision ?? 0 }),
);

/** Removes one structured field by its stable visible position. */
function removeField(kind: "query" | "headers", index: number): void {
  const fields = kind === "query" ? query : headers;
  fields.value.splice(index, 1);
  ensureTrailingBlankRequestField(
    fields.value,
    kind === "headers" ? createBlankHeaderField : undefined,
  );
  emitChange();
}

/** Removes a field from the currently visible structured editor. */
function removeActiveField(index: number): void {
  removeField(activeTab.value === "headers" ? "headers" : "query", index);
}

/** Returns the editable field list currently shown by the active table tab. */
function activeFields(): RequestField[] {
  return activeTab.value === "headers" ? headers.value : query.value;
}

/** Moves one query/header row and preserves the trailing blank entry. */
function moveActiveField(fromIndex: number, toIndex: number): void {
  const fields = activeFields();
  const [field] = fields.splice(fromIndex, 1);
  if (field !== undefined) fields.splice(toIndex, 0, field);
  ensureTrailingBlankRequestField(
    fields,
    activeTab.value === "headers" ? createBlankHeaderField : undefined,
  );
  emitChange();
}

const fieldReorder = useRowReorder({
  canMove: (index) =>
    activeFields()[index] !== undefined &&
    !isBlankRequestField(activeFields()[index]!),
  move: moveActiveField,
  isDisabled: () => editorDisabled.value,
});

/** Publishes a field edit and materializes the next trailing blank row. */
function updateActiveField(index?: number, nameChanged = false): void {
  const fields = activeTab.value === "headers" ? headers : query;
  if (activeTab.value === "headers" && nameChanged && index !== undefined) {
    const header = fields.value[index];
    if (header !== undefined) {
      header.mode = defaultHeaderMergeMode(header.name);
    }
  }
  ensureTrailingBlankRequestField(
    fields.value,
    activeTab.value === "headers" ? createBlankHeaderField : undefined,
  );
  emitChange();
}

/** Reports whether the current request replaces one inherited header pair. */
function isInheritedHeaderOverridden(field: RequestField): boolean {
  return overriddenInheritedHeaderNames.value.has(field.name.toLowerCase());
}

/** Builds an immutable draft payload from the current editor controls. */
function currentDraft(): RequestDraftInput {
  return {
    name: name.value,
    method: method.value,
    targetMode: targetMode.value,
    targetUrl: targetUrl.value,
    query: meaningfulRequestFields(query.value),
    headers: meaningfulRequestFields(headers.value),
    body: body.value,
    preRequestScript: preRequestScript.value,
    postResponseScript: postResponseScript.value,
  };
}

/** Publishes current editor content to its owning request tab. */
function emitChange(): void {
  emit("change", {
    name: name.value,
    method: method.value,
    targetMode: targetMode.value,
    targetUrl: targetUrl.value,
    query: meaningfulRequestFields(query.value),
    headers: meaningfulRequestFields(headers.value),
    body: body.value,
    preRequestScript: preRequestScript.value,
    postResponseScript: postResponseScript.value,
  });
}

/** Applies a method selected from the shared option menu. */
function selectMethod(value: string): void {
  method.value = value as HttpMethod;
  emitChange();
}

/** Applies a target mode and publishes it with the current draft. */
function selectTargetMode(value: string): void {
  if (value === "absolute" || value === "composed") {
    targetMode.value = value;
    emitChange();
  }
}

/** Returns the translated label for a request settings tab. */
function requestTabLabel(tab: (typeof requestTabs)[number]): string {
  if (tab === "query") {
    return t("request.query");
  }
  if (tab === "headers") {
    return t("request.headers");
  }
  if (tab === "body") {
    return t("request.body");
  }
  if (tab === "preRequest") {
    return t("scripting.preRequest");
  }
  if (tab === "versions") {
    return t("request.versions.title");
  }
  return tab === "postResponse"
    ? t("scripting.postResponse")
    : t("environment.variables");
}

/** Persists a trimmed version name or removes the current one when blank. */
function saveVersionName(): void {
  const revisionId = props.viewingRevision?.revisionId;
  if (revisionId !== undefined) {
    emit("nameRevision", revisionId, versionName.value.trim() || null);
  }
}

/** Formats one immutable revision timestamp in the current locale. */
function revisionDate(revision: RequestRevisionSummary): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(revision.createdAt));
}

/** Returns a user name or the localized automatic revision reason. */
function revisionLabel(revision: RequestRevisionSummary): string {
  return revision.name ?? t(`request.versions.${revision.creationReason}`);
}

/** Returns the translated singular label for the active structured field. */
function activeFieldKind(): string {
  return activeTab.value === "headers"
    ? t("request.headerField")
    : t("request.queryField");
}

/** Emits the complete persisted request-variable profile from its inline tab. */
function saveVariables(): void {
  if (props.canEdit && props.requestVariableProfile !== null) {
    emit("saveVariables", variableEditor.value?.writes() ?? []);
  }
}

/** Constrains one splitter position to usable request and response panes. */
function setRequestPaneFromClientY(clientY: number): void {
  const bounds = workbench.value?.getBoundingClientRect();
  if (bounds === undefined || bounds.height <= 0) return;
  const availableHeight = Math.max(bounds.height - 8, 1);
  const minimumRequestHeight = Math.min(260, availableHeight * 0.45);
  const minimumResponseHeight = Math.min(112, availableHeight * 0.3);
  const requestHeight = Math.min(
    Math.max(clientY - bounds.top, minimumRequestHeight),
    availableHeight - minimumResponseHeight,
  );
  requestPanePercent.value = (requestHeight / bounds.height) * 100;
}

/** Starts pointer-captured resizing from the horizontal pane separator. */
function startPaneResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  resizingPointerId.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  setRequestPaneFromClientY(event.clientY);
}

/** Applies pointer movement while the separator owns the active pointer. */
function continuePaneResize(event: PointerEvent): void {
  if (resizingPointerId.value !== event.pointerId) return;
  setRequestPaneFromClientY(event.clientY);
}

/** Releases pointer capture and ends the current pane resize gesture. */
function finishPaneResize(event: PointerEvent): void {
  if (resizingPointerId.value !== event.pointerId) return;
  resizingPointerId.value = null;
  const separator = event.currentTarget as HTMLElement;
  if (separator.hasPointerCapture?.(event.pointerId)) {
    separator.releasePointerCapture(event.pointerId);
  }
}

/** Ends resizing if the browser revokes pointer capture unexpectedly. */
function cancelPaneResize(): void {
  resizingPointerId.value = null;
}

/** Resizes the panes with arrow keys or jumps to either usable limit. */
function resizePanesByKeyboard(event: KeyboardEvent): void {
  const bounds = workbench.value?.getBoundingClientRect();
  if (bounds === undefined || bounds.height <= 0) return;
  const currentY =
    bounds.top + (requestPanePercent.value / 100) * bounds.height;
  let nextY: number;
  if (event.key === "ArrowUp") {
    nextY = currentY - bounds.height * 0.04;
  } else if (event.key === "ArrowDown") {
    nextY = currentY + bounds.height * 0.04;
  } else if (event.key === "Home") {
    nextY = bounds.top;
  } else if (event.key === "End") {
    nextY = bounds.bottom;
  } else {
    return;
  }
  event.preventDefault();
  setRequestPaneFromClientY(nextY);
}
</script>

<template>
  <main
    id="request-workbench"
    ref="workbench"
    class="request-workbench"
    role="tabpanel"
    :style="paneStyle"
    :data-resizing="resizingPointerId === null ? undefined : ''"
    :aria-labelledby="tabId === null ? undefined : `request-tab-${tabId}`"
  >
    <div v-if="draft === null" class="empty-workbench">
      <h1>{{ t("request.selectTitle") }}</h1>
      <p>{{ t("request.selectDescription") }}</p>
    </div>
    <template v-else>
      <section class="request-editor" aria-labelledby="request-name">
        <div class="request-title-row">
          <div class="request-title">
            <TextInput
              id="request-name"
              v-model="name"
              class="request-name-input"
              :aria-label="t('request.name')"
              :disabled="editorDisabled"
              @input="emitChange"
            />
            <span class="draft-revision">
              {{ draftRevisionLabel }}
            </span>
          </div>
          <div class="command-bar">
            <ButtonControl
              variant="secondary"
              :disabled="busy || !canSave"
              @click="emit('save', currentDraft())"
            >
              <template #leading>
                <Save :size="16" aria-hidden="true" />
              </template>
              {{ t("common.actions.save") }}
            </ButtonControl>
            <ButtonControl
              variant="primary"
              :disabled="busy || !validTarget"
              @click="
                viewingRevision === null
                  ? emit('execute', currentDraft())
                  : emit('executeRevision', viewingRevision.revisionId)
              "
            >
              <template #leading>
                <Play :size="16" aria-hidden="true" />
              </template>
              {{ t("request.send") }}
            </ButtonControl>
          </div>
        </div>

        <div class="target-row">
          <SelectMenu
            class="method-picker"
            :model-value="method"
            :options="methodOptions"
            :label="t('request.httpMethod')"
            :disabled="editorDisabled"
            @update:model-value="selectMethod"
          >
            <template #option="{ option }">
              <span class="method-option">{{ option.label }}</span>
            </template>
          </SelectMenu>
          <SelectMenu
            class="target-mode-picker"
            :model-value="targetMode"
            :options="targetModeOptions"
            :label="t('request.targetMode')"
            :disabled="editorDisabled"
            @update:model-value="selectTargetMode"
          >
            <template #selected="{ option }">
              <Globe2
                v-if="option?.value === 'absolute'"
                :size="17"
                aria-hidden="true"
              />
              <Route v-else :size="17" aria-hidden="true" />
            </template>
            <template #option="{ option }">
              <span class="target-mode-option">
                <Globe2
                  v-if="option.value === 'absolute'"
                  :size="17"
                  aria-hidden="true"
                />
                <Route v-else :size="17" aria-hidden="true" />
                <span>{{ option.label }}</span>
              </span>
            </template>
          </SelectMenu>
          <div v-if="targetMode === 'composed'" class="composed-target-inputs">
            <TemplateTextControl
              :model-value="displayedInheritedTarget"
              class="url-template-input inherited-target-input"
              :style="{ width: inheritedTargetWidth }"
              font="mono"
              :previews="variablePreviews"
              :aria-label="t('request.inheritedTarget')"
              readonly
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
            />
            <TemplateTextControl
              v-model="targetUrl"
              class="url-template-input request-path-input"
              font="mono"
              :previews="variablePreviews"
              :aria-label="t('request.requestPath')"
              :placeholder="t('request.requestPathPlaceholder')"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              :disabled="editorDisabled"
              @input="emitChange"
            />
          </div>
          <TemplateTextControl
            v-else
            v-model="targetUrl"
            class="url-template-input"
            font="mono"
            :previews="variablePreviews"
            :aria-label="t('request.targetUrl')"
            :placeholder="t('request.targetUrlPlaceholder')"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            :disabled="editorDisabled"
            @input="emitChange"
          />
        </div>

        <TabsRoot
          v-model="activeTab"
          class="request-settings-tabs"
          activation-mode="manual"
        >
          <TabsList class="request-tabs" :label="t('request.requestSettings')">
            <TabsTrigger
              v-for="tab in requestTabs"
              :key="tab"
              class="tab-button"
              :value="tab"
            >
              {{ requestTabLabel(tab) }}
              <span v-if="tab === 'query'" class="tab-count">
                {{ queryCount }}
              </span>
              <span v-else-if="tab === 'headers'" class="tab-count">
                {{ headerCount }}
              </span>
              <span
                v-else-if="tab === 'variables' && requestVariableCount !== null"
                class="tab-count"
              >
                {{ requestVariableCount }}
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsPanel
            v-if="activeTab === 'query' || activeTab === 'headers'"
            :value="activeTab"
            class="request-fields"
          >
            <div class="request-field-heading" aria-hidden="true">
              <span></span>
              <span>{{ t("common.fields.name") }}</span>
              <span>{{ t("common.fields.value") }}</span>
              <span></span>
            </div>
            <div
              v-for="(field, index) in activeTab === 'headers'
                ? inheritedHeaders
                : []"
              :key="`inherited-${index}`"
              class="request-field-row inherited-header-row"
              :class="{
                'is-header-overridden': isInheritedHeaderOverridden(field),
              }"
            >
              <CheckboxControl
                :model-value="field.enabled"
                visually-hidden-label
                :label="
                  t('request.inheritedHeaderEnabled', { index: index + 1 })
                "
                disabled
              />
              <TextInput
                :model-value="field.name"
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
                  :model-value="field.mode ?? 'override'"
                  readonly
                />
                <TemplateTextControl
                  :model-value="field.value"
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
                  isInheritedHeaderOverridden(field)
                    ? t('request.inheritedHeaderOverridden')
                    : t('request.inherited')
                "
                :title="
                  isInheritedHeaderOverridden(field)
                    ? t('request.inheritedHeaderOverridden')
                    : t('request.inherited')
                "
              >
                <Lock :size="14" aria-hidden="true" />
              </span>
            </div>
            <div
              v-for="(field, index) in activeTab === 'query' ? query : headers"
              :key="index"
              class="request-field-row"
              :class="fieldReorder.classes(index)"
              @dragover.stop="fieldReorder.updateDropTarget($event, index)"
              @drop.stop="fieldReorder.finishDrop($event)"
            >
              <CheckboxControl
                v-model="field.enabled"
                visually-hidden-label
                :label="
                  t('request.enableField', {
                    kind: activeFieldKind(),
                    index: index + 1,
                  })
                "
                :disabled="editorDisabled"
                @change="emitChange"
              />
              <TextInput
                v-model="field.name"
                class="field-cell-input"
                density="compact"
                font="mono"
                :aria-label="
                  t(
                    activeTab === 'query'
                      ? 'request.queryName'
                      : 'request.headerName',
                    { index: index + 1 },
                  )
                "
                :placeholder="
                  isBlankRequestField(field)
                    ? activeTab === 'query'
                      ? t('request.addParameter')
                      : t('request.addHeader')
                    : t('common.fields.name')
                "
                autocomplete="off"
                spellcheck="false"
                :disabled="editorDisabled"
                @input="updateActiveField(index, true)"
              />
              <div v-if="activeTab === 'headers'" class="header-value-field">
                <HeaderMergeModeToggle
                  :model-value="field.mode ?? 'override'"
                  :disabled="editorDisabled"
                  @update:model-value="field.mode = $event"
                  @change="emitChange"
                />
                <TemplateTextControl
                  v-model="field.value"
                  class="field-template-input"
                  density="compact"
                  font="mono"
                  :previews="variablePreviews"
                  :aria-label="t('request.headerValue', { index: index + 1 })"
                  :placeholder="t('common.fields.value')"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="editorDisabled"
                  @input="updateActiveField(index)"
                />
              </div>
              <TemplateTextControl
                v-else
                v-model="field.value"
                class="field-template-input"
                density="compact"
                font="mono"
                :previews="variablePreviews"
                :aria-label="t('request.queryValue', { index: index + 1 })"
                :placeholder="t('common.fields.value')"
                autocomplete="off"
                spellcheck="false"
                :disabled="editorDisabled"
                @input="updateActiveField(index)"
              />
              <div class="row-actions">
                <RowReorderHandle
                  v-if="!isBlankRequestField(field)"
                  :label="
                    t('common.actions.reorderRow', {
                      item: activeFieldKind(),
                      index: index + 1,
                    })
                  "
                  :disabled="editorDisabled"
                  @drag-start="fieldReorder.startDrag($event, index)"
                  @drag-end="fieldReorder.cancelDrag"
                  @move="fieldReorder.moveByKeyboard(index, $event)"
                />
                <IconButton
                  v-if="!isBlankRequestField(field)"
                  class="compact-icon-button"
                  size="compact"
                  :label="
                    t('request.removeField', {
                      kind: activeFieldKind(),
                      index: index + 1,
                    })
                  "
                  :title="
                    t('request.removeFieldTitle', {
                      kind: activeFieldKind(),
                    })
                  "
                  :disabled="editorDisabled"
                  @click="removeActiveField(index)"
                >
                  <Trash2 :size="15" aria-hidden="true" />
                </IconButton>
                <span v-else class="new-row-marker" aria-hidden="true">
                  <Asterisk :size="15" />
                </span>
              </div>
            </div>
          </TabsPanel>

          <TabsPanel
            v-if="activeTab === 'body'"
            value="body"
            class="request-body-editor"
          >
            <TemplateTextControl
              v-model="body"
              class="body-template-input"
              multiline
              font="mono"
              :previews="variablePreviews"
              :aria-label="t('request.rawBody')"
              :placeholder="t('request.rawBody')"
              spellcheck="false"
              :disabled="editorDisabled"
              @input="emitChange"
            />
          </TabsPanel>

          <TabsPanel
            v-if="activeTab === 'preRequest'"
            value="preRequest"
            class="request-script-editor"
          >
            <div class="script-editor-section">
              <div class="script-editor-heading">
                <span class="script-editor-title">
                  {{ t("scripting.preRequest") }}
                </span>
                <span>{{ t("scripting.preRequestDescription") }}</span>
              </div>
              <ScriptEditor
                id="pre-request-script"
                v-model="preRequestScript"
                class="script-source-input"
                :label="t('scripting.preRequest')"
                :disabled="editorDisabled"
                @input="emitChange"
              />
            </div>
          </TabsPanel>

          <TabsPanel
            v-if="activeTab === 'postResponse'"
            value="postResponse"
            class="request-script-editor"
          >
            <div class="script-editor-section">
              <div class="script-editor-heading">
                <span class="script-editor-title">
                  {{ t("scripting.postResponse") }}
                </span>
                <span>{{ t("scripting.postResponseDescription") }}</span>
              </div>
              <ScriptEditor
                id="post-response-script"
                v-model="postResponseScript"
                class="script-source-input"
                :label="t('scripting.postResponse')"
                :disabled="editorDisabled"
                @input="emitChange"
              />
            </div>
          </TabsPanel>

          <TabsPanel
            v-if="activeTab === 'variables'"
            value="variables"
            class="request-variables-editor"
          >
            <p v-if="temporary" class="resource-dialog-context">
              {{ t("variables.requestUnavailable") }}
            </p>
            <p
              v-else-if="requestVariableProfile === null"
              class="resource-dialog-context"
              role="status"
            >
              {{ t("variables.loading") }}
            </p>
            <template v-else>
              <InlineWarning :title="t('variables.requestWarningTitle')">
                {{ t("variables.requestDescription") }}
              </InlineWarning>
              <VariableFieldsEditor
                :key="`${requestVariableProfile.scopeId}:${requestVariableProfile.revision}`"
                ref="variableEditor"
                :profile-variables="requestVariableProfile.variables"
                :can-edit="canEdit"
                :busy="busy"
                @count-change="requestVariableCount = $event"
              />
              <div v-if="canEdit" class="request-variable-actions">
                <ButtonControl
                  variant="primary"
                  :disabled="editorDisabled"
                  @click="saveVariables"
                >
                  {{ t("variables.saveRequest") }}
                </ButtonControl>
              </div>
            </template>
          </TabsPanel>
          <TabsPanel
            v-if="activeTab === 'versions'"
            value="versions"
            class="request-versions"
            :class="{ 'has-selected-version': viewingRevision !== null }"
          >
            <div class="request-version-list">
              <button
                type="button"
                class="request-version-card"
                :class="{ 'is-selected': viewingRevision === null }"
                @click="emit('selectRevision', null)"
              >
                <History :size="16" aria-hidden="true" />
                <span>
                  <strong>{{ t("request.versions.currentDraft") }}</strong>
                  <small>{{ draftRevisionLabel }}</small>
                </span>
              </button>
              <button
                v-for="revision in revisions"
                :key="revision.revisionId"
                type="button"
                class="request-version-card"
                :class="{
                  'is-selected':
                    viewingRevision?.revisionId === revision.revisionId,
                }"
                @click="emit('selectRevision', revision.revisionId)"
              >
                <History :size="16" aria-hidden="true" />
                <span>
                  <strong>
                    {{ revisionLabel(revision) }}
                  </strong>
                  <small>
                    {{ revisionDate(revision) }} ·
                    {{ revision.createdByUsername }}
                  </small>
                </span>
              </button>
              <p v-if="revisions.length === 0" class="dialog-empty-message">
                {{ t("request.versions.empty") }}
              </p>
            </div>
            <div v-if="viewingRevision" class="request-version-details">
              <TextInput
                v-model="versionName"
                :aria-label="t('request.versions.name')"
                :placeholder="t('request.versions.namePlaceholder')"
                :disabled="busy || !canEdit"
              />
              <div class="request-version-actions">
                <ButtonControl
                  variant="secondary"
                  :disabled="busy || !canEdit"
                  @click="saveVersionName"
                >
                  {{ t("request.versions.saveName") }}
                </ButtonControl>
                <ButtonControl
                  variant="secondary"
                  :disabled="busy || !canEdit"
                  @click="emit('restoreRevision', viewingRevision.revisionId)"
                >
                  {{ t("request.versions.restore") }}
                </ButtonControl>
              </div>
              <p class="resource-dialog-context">
                {{ t("request.versions.readOnly") }}
              </p>
            </div>
          </TabsPanel>
        </TabsRoot>
      </section>
      <div
        class="request-pane-separator"
        role="separator"
        tabindex="0"
        aria-orientation="horizontal"
        :aria-label="t('request.resizePanes')"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(requestPanePercent)"
        @pointerdown="startPaneResize"
        @pointermove="continuePaneResize"
        @pointerup="finishPaneResize"
        @pointercancel="finishPaneResize"
        @lostpointercapture="cancelPaneResize"
        @keydown="resizePanesByKeyboard"
      ></div>
      <ResponsePanel
        :execution="execution"
        @download="emit('download', $event)"
      />
    </template>
  </main>
</template>
