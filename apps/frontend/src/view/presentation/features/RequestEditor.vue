<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Play, Plus, Save, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestView,
} from "@/model/contracts/backend";
import type { RequestDraftInput } from "@/model/domain/application";
import ResponsePanel from "./ResponsePanel.vue";

const props = defineProps<{
  request: RequestView | null;
  draft: RequestDraftInput | null;
  execution: ExecutionView | null;
  temporary: boolean;
  busy: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  save: [draft: RequestDraftInput];
  execute: [draft: RequestDraftInput];
  change: [draft: RequestDraftInput];
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
const validTarget = computed(() => {
  try {
    const url = new URL(targetUrl.value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
});
const canSave = computed(() => name.value.trim() !== "" && validTarget.value);
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
  <main class="request-workbench">
    <div v-if="draft === null" class="empty-workbench">
      <h1>{{ t("request.selectTitle") }}</h1>
      <p>{{ t("request.selectDescription") }}</p>
    </div>
    <template v-else>
      <section class="request-editor" aria-labelledby="request-name">
        <div class="request-title-row">
          <div class="request-title">
            <input
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
            <button
              class="secondary-button"
              type="button"
              :disabled="busy || !canSave"
              @click="emit('save', currentDraft())"
            >
              <Save :size="16" aria-hidden="true" />
              {{ t("common.actions.save") }}
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="busy || !validTarget"
              @click="emit('execute', currentDraft())"
            >
              <Play :size="16" aria-hidden="true" />
              {{ t("request.send") }}
            </button>
          </div>
        </div>

        <div class="target-row">
          <select
            v-model="method"
            class="method-control"
            :aria-label="t('request.httpMethod')"
            :disabled="busy"
            @change="emitChange"
          >
            <option v-for="option in methods" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
          <input
            v-model="targetUrl"
            class="url-input"
            :aria-label="t('request.targetUrl')"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            @input="emitChange"
          />
        </div>

        <div
          class="request-tabs"
          role="tablist"
          :aria-label="t('request.requestSettings')"
        >
          <button
            v-for="tab in requestTabs"
            :key="tab"
            class="tab-button"
            :class="{ 'is-active': activeTab === tab }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab"
            @click="activeTab = tab"
          >
            {{ requestTabLabel(tab) }}
            <span v-if="tab !== 'body'" class="tab-count">
              {{ tab === "query" ? query.length : headers.length }}
            </span>
          </button>
        </div>

        <div v-if="activeTab !== 'body'" class="request-fields">
          <div class="request-field-heading" aria-hidden="true">
            <span></span>
            <span>{{ t("common.fields.name") }}</span>
            <span>{{ t("common.fields.value") }}</span>
            <span></span>
          </div>
          <div
            v-for="(field, index) in activeTab === 'query' ? query : headers"
            :key="index"
            class="request-field-row"
          >
            <input
              v-model="field.enabled"
              type="checkbox"
              :aria-label="
                t('request.enableField', {
                  kind: activeFieldKind(),
                  index: index + 1,
                })
              "
              :disabled="busy"
              @change="emitChange"
            />
            <input
              v-model="field.name"
              class="field-cell-input"
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
            <input
              v-model="field.value"
              class="field-cell-input"
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
            <button
              class="icon-button compact-icon-button"
              type="button"
              :aria-label="
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
            </button>
          </div>
          <button
            class="add-field-button"
            type="button"
            :disabled="busy"
            @click="addActiveField"
          >
            <Plus :size="15" aria-hidden="true" />
            {{
              activeTab === "query"
                ? t("request.addParameter")
                : t("request.addHeader")
            }}
          </button>
        </div>

        <div v-else class="request-body-editor">
          <textarea
            v-model="body"
            class="raw-body-input"
            :aria-label="t('request.rawBody')"
            :placeholder="t('request.rawBody')"
            spellcheck="false"
            :disabled="busy"
            @input="emitChange"
          ></textarea>
        </div>
      </section>
      <ResponsePanel :execution="execution" />
    </template>
  </main>
</template>
