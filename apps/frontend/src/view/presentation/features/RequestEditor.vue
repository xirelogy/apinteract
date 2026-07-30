<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Lock, Play, Plus, Save, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestView,
} from "@/model/contracts/backend";
import type { RequestDraftInput } from "@/model/domain/application";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextArea from "@/view/presentation/controls/TextArea.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import ResponsePanel from "./ResponsePanel.vue";

const props = defineProps<{
  request: RequestView | null;
  draft: RequestDraftInput | null;
  execution: ExecutionView | null;
  tabId: string | null;
  temporary: boolean;
  inheritedHeaders: readonly RequestField[];
  busy: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  save: [draft: RequestDraftInput];
  execute: [draft: RequestDraftInput];
  change: [draft: RequestDraftInput];
  download: [executionId: string];
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
const requestTabs = ["query", "headers", "body"] as const;
const name = ref("");
const method = ref<HttpMethod>("GET");
const targetUrl = ref("");
const query = ref<RequestField[]>([]);
const headers = ref<RequestField[]>([]);
const body = ref("");
const activeTab = ref<"query" | "headers" | "body">("query");

watch(
  () => props.draft,
  (draft) => {
    name.value = draft?.name ?? "";
    method.value = draft?.method ?? "GET";
    targetUrl.value = draft?.targetUrl ?? "";
    query.value = cloneFields(draft?.query ?? []);
    headers.value = cloneFields(draft?.headers ?? []);
    body.value = draft?.body ?? "";
  },
  { immediate: true },
);
const validTarget = computed(() => isValidTargetTemplate(targetUrl.value));

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
const canSave = computed(
  () => validTarget.value && (props.temporary || name.value.trim() !== ""),
);
const draftRevisionLabel = computed(() =>
  props.temporary
    ? t("request.temporary")
    : t("request.draft", { revision: props.request?.draftRevision ?? 0 }),
);

/** Returns mutable field copies without sharing generated contract objects. */
function cloneFields(fields: readonly RequestField[]): RequestField[] {
  return fields.map((field) => ({ ...field }));
}

/** Appends one enabled empty field to the requested structured editor. */
function addField(kind: "query" | "headers"): void {
  const fields = kind === "query" ? query : headers;
  fields.value.push({ name: "", value: "", enabled: true });
  emitChange();
}

/** Appends a field to the currently visible structured editor. */
function addActiveField(): void {
  addField(activeTab.value === "headers" ? "headers" : "query");
}

/** Removes one structured field by its stable visible position. */
function removeField(kind: "query" | "headers", index: number): void {
  const fields = kind === "query" ? query : headers;
  fields.value.splice(index, 1);
  emitChange();
}

/** Removes a field from the currently visible structured editor. */
function removeActiveField(index: number): void {
  removeField(activeTab.value === "headers" ? "headers" : "query", index);
}

/** Builds an immutable draft payload from the current editor controls. */
function currentDraft(): RequestDraftInput {
  return {
    name: name.value,
    method: method.value,
    targetUrl: targetUrl.value,
    query: meaningfulFields(query.value),
    headers: meaningfulFields(headers.value),
    body: body.value,
  };
}

/** Publishes current editor content to its owning request tab. */
function emitChange(): void {
  emit("change", {
    name: name.value,
    method: method.value,
    targetUrl: targetUrl.value,
    query: cloneFields(query.value),
    headers: cloneFields(headers.value),
    body: body.value,
  });
}

/** Omits untouched placeholder rows while preserving meaningful disabled fields. */
function meaningfulFields(fields: readonly RequestField[]): RequestField[] {
  return cloneFields(
    fields.filter((field) => field.name !== "" || field.value !== ""),
  );
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
  return tab === "headers" ? t("request.headers") : t("request.body");
}

/** Returns the translated singular label for the active structured field. */
function activeFieldKind(): string {
  return activeTab.value === "headers"
    ? t("request.headerField")
    : t("request.queryField");
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
          <TextInput
            v-model="targetUrl"
            class="url-input"
            font="mono"
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
              <span v-if="tab !== 'body'" class="tab-count">
                {{
                  tab === "query"
                    ? query.length
                    : headers.length + inheritedHeaders.length
                }}
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsPanel
            v-if="activeTab !== 'body'"
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
              <TextInput
                :model-value="field.value"
                class="field-cell-input"
                density="compact"
                font="mono"
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
                :placeholder="t('common.fields.name')"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
                @input="emitChange"
              />
              <TextInput
                v-model="field.value"
                class="field-cell-input"
                density="compact"
                font="mono"
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
                @input="emitChange"
              />
              <IconButton
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
            </div>
            <ButtonControl
              class="add-field-button"
              variant="ghost"
              size="compact"
              :disabled="busy"
              @click="addActiveField"
            >
              <template #leading>
                <Plus :size="15" aria-hidden="true" />
              </template>
              {{
                activeTab === "query"
                  ? t("request.addParameter")
                  : t("request.addHeader")
              }}
            </ButtonControl>
          </TabsPanel>

          <TabsPanel v-else value="body" class="request-body-editor">
            <TextArea
              v-model="body"
              class="raw-body-input"
              font="mono"
              :aria-label="t('request.rawBody')"
              :placeholder="t('request.rawBody')"
              spellcheck="false"
              :disabled="busy"
              @input="emitChange"
            />
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
