<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Asterisk, Lock, Play, Save, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestView,
  VariableProfileView,
  VariablePreview,
  VariableWrite,
} from "@/model/contracts/backend";
import type { RequestDraftInput } from "@/model/domain/application";
import {
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
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TemplateTextControl from "@/view/presentation/controls/TemplateTextControl.vue";
import TextArea from "@/view/presentation/controls/TextArea.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import ResponsePanel from "./ResponsePanel.vue";
import VariableFieldsEditor from "./VariableFieldsEditor.vue";

interface VariableFieldsEditorApi {
  writes(): VariableWrite[];
}

const props = withDefaults(
  defineProps<{
    request: RequestView | null;
    draft: RequestDraftInput | null;
    execution: ExecutionView | null;
    tabId: string | null;
    temporary: boolean;
    inheritedHeaders: readonly RequestField[];
    requestVariableProfile?: VariableProfileView | null;
    variablePreviews?: readonly VariablePreview[];
    previewContextKey?: string | null;
    busy: boolean;
    canEdit?: boolean;
  }>(),
  {
    variablePreviews: () => [],
    requestVariableProfile: null,
    previewContextKey: null,
    canEdit: true,
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
const requestTabs = [
  "query",
  "headers",
  "body",
  "preRequest",
  "postResponse",
  "variables",
] as const;
const name = ref("");
const method = ref<HttpMethod>("GET");
const targetUrl = ref("");
const query = ref<RequestField[]>([]);
const headers = ref<RequestField[]>([]);
const body = ref("");
const preRequestScript = ref("");
const postResponseScript = ref("");
const activeTab = ref<(typeof requestTabs)[number]>("query");
const variableEditor = ref<VariableFieldsEditorApi | null>(null);
const requestVariableCount = ref<number | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.draft,
  (draft) => {
    name.value = draft?.name ?? "";
    method.value = draft?.method ?? "GET";
    targetUrl.value = draft?.targetUrl ?? "";
    query.value = editableRequestFields(draft?.query ?? [], true);
    headers.value = editableRequestFields(draft?.headers ?? [], true);
    body.value = draft?.body ?? "";
    preRequestScript.value = draft?.preRequestScript ?? "";
    postResponseScript.value = draft?.postResponseScript ?? "";
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
const validTarget = computed(() => isValidTargetTemplate(targetUrl.value));
const queryCount = computed(() => meaningfulRequestFields(query.value).length);
const headerCount = computed(
  () =>
    meaningfulRequestFields(headers.value).length +
    props.inheritedHeaders.length,
);
const referencedVariableNames = computed(() =>
  collectTemplateVariableNames([
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
  () => validTarget.value && (props.temporary || name.value.trim() !== ""),
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
  ensureTrailingBlankRequestField(fields.value);
  emitChange();
}

/** Removes a field from the currently visible structured editor. */
function removeActiveField(index: number): void {
  removeField(activeTab.value === "headers" ? "headers" : "query", index);
}

/** Publishes a field edit and materializes the next trailing blank row. */
function updateActiveField(): void {
  const fields = activeTab.value === "headers" ? headers : query;
  ensureTrailingBlankRequestField(fields.value);
  emitChange();
}

/** Builds an immutable draft payload from the current editor controls. */
function currentDraft(): RequestDraftInput {
  return {
    name: name.value,
    method: method.value,
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
  return tab === "postResponse"
    ? t("scripting.postResponse")
    : t("environment.variables");
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
</script>

<template>
  <main
    id="request-workbench"
    class="request-workbench"
    role="tabpanel"
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
              :disabled="busy"
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
              @click="emit('execute', currentDraft())"
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
            :disabled="busy"
            @update:model-value="selectMethod"
          >
            <template #option="{ option }">
              <span class="method-option">{{ option.label }}</span>
            </template>
          </SelectMenu>
          <TemplateTextControl
            v-model="targetUrl"
            class="url-template-input"
            font="mono"
            :previews="variablePreviews"
            :aria-label="t('request.targetUrl')"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
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
              <TemplateTextControl
                :model-value="field.value"
                class="field-template-input"
                density="compact"
                font="mono"
                :previews="variablePreviews"
                :aria-label="
                  t('request.inheritedHeaderValue', { index: index + 1 })
                "
                disabled
              />
              <span
                class="inherited-header-indicator"
                role="img"
                :aria-label="t('request.inherited')"
                :title="t('request.inherited')"
              >
                <Lock :size="14" aria-hidden="true" />
              </span>
            </div>
            <div
              v-for="(field, index) in activeTab === 'query' ? query : headers"
              :key="index"
              class="request-field-row"
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
                :disabled="busy"
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
                :disabled="busy"
                @input="updateActiveField"
              />
              <TemplateTextControl
                v-model="field.value"
                class="field-template-input"
                density="compact"
                font="mono"
                :previews="variablePreviews"
                :aria-label="
                  t(
                    activeTab === 'query'
                      ? 'request.queryValue'
                      : 'request.headerValue',
                    { index: index + 1 },
                  )
                "
                :placeholder="t('common.fields.value')"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
                @input="updateActiveField"
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
                :disabled="busy"
                @click="removeActiveField(index)"
              >
                <Trash2 :size="15" aria-hidden="true" />
              </IconButton>
              <span v-else class="new-row-marker" aria-hidden="true">
                <Asterisk :size="15" />
              </span>
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
              :disabled="busy"
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
                <label for="pre-request-script">
                  {{ t("scripting.preRequest") }}
                </label>
                <span>{{ t("scripting.preRequestDescription") }}</span>
              </div>
              <TextArea
                id="pre-request-script"
                v-model="preRequestScript"
                class="script-source-input"
                font="mono"
                :aria-label="t('scripting.preRequest')"
                :disabled="busy"
                spellcheck="false"
                @input="emitChange"
              />
            </div>
            <p class="script-sdk-help">
              {{ t("scripting.sdkHelp") }}
              <code>asdk</code>.
            </p>
          </TabsPanel>

          <TabsPanel
            v-if="activeTab === 'postResponse'"
            value="postResponse"
            class="request-script-editor"
          >
            <div class="script-editor-section">
              <div class="script-editor-heading">
                <label for="post-response-script">
                  {{ t("scripting.postResponse") }}
                </label>
                <span>{{ t("scripting.postResponseDescription") }}</span>
              </div>
              <TextArea
                id="post-response-script"
                v-model="postResponseScript"
                class="script-source-input"
                font="mono"
                :aria-label="t('scripting.postResponse')"
                :disabled="busy"
                spellcheck="false"
                @input="emitChange"
              />
            </div>
            <p class="script-sdk-help">
              {{ t("scripting.sdkHelp") }}
              <code>asdk</code>.
            </p>
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
                  :disabled="busy"
                  @click="saveVariables"
                >
                  {{ t("variables.saveRequest") }}
                </ButtonControl>
              </div>
            </template>
          </TabsPanel>
        </TabsRoot>
      </section>
      <ResponsePanel
        :execution="execution"
        @download="emit('download', $event)"
      />
    </template>
  </main>
</template>
