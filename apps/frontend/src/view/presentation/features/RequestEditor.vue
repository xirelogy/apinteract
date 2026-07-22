<script setup lang="ts">
import { ref, watch } from "vue";
import { Play, Plus, Save, Trash2 } from "@lucide/vue";

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
  execution: ExecutionView | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  save: [draft: RequestDraftInput];
  execute: [draft: RequestDraftInput];
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
  () => props.request,
  (request) => {
    name.value = request?.name ?? "";
    method.value = request?.method ?? "GET";
    targetUrl.value = request?.targetUrl ?? "";
    query.value = cloneFields(request?.query ?? []);
    headers.value = cloneFields(request?.headers ?? []);
    body.value = request?.body ?? "";
  },
  { immediate: true },
);

/** Returns mutable field copies without sharing generated contract objects. */
function cloneFields(fields: readonly RequestField[]): RequestField[] {
  return fields.map((field) => ({ ...field }));
}

/** Appends one enabled empty field to the requested structured editor. */
function addField(kind: "query" | "headers"): void {
  const fields = kind === "query" ? query : headers;
  fields.value.push({ name: "", value: "", enabled: true });
}

/** Appends a field to the currently visible structured editor. */
function addActiveField(): void {
  addField(activeTab.value === "headers" ? "headers" : "query");
}

/** Removes one structured field by its stable visible position. */
function removeField(kind: "query" | "headers", index: number): void {
  const fields = kind === "query" ? query : headers;
  fields.value.splice(index, 1);
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

/** Omits untouched placeholder rows while preserving meaningful disabled fields. */
function meaningfulFields(fields: readonly RequestField[]): RequestField[] {
  return cloneFields(
    fields.filter((field) => field.name !== "" || field.value !== ""),
  );
}
</script>

<template>
  <main class="request-workbench">
    <div v-if="request === null" class="empty-workbench">
      <h1>Select a request</h1>
      <p>Choose a collection and request from the workspace navigator.</p>
    </div>
    <template v-else>
      <section class="request-editor" aria-labelledby="request-name">
        <div class="request-title-row">
          <div class="request-title">
            <input
              id="request-name"
              v-model="name"
              class="request-name-input"
              aria-label="Request name"
              :disabled="busy"
            />
            <span class="draft-revision">
              Draft {{ request.draftRevision }}
            </span>
          </div>
          <div class="command-bar">
            <button
              class="secondary-button"
              type="button"
              :disabled="busy"
              @click="emit('save', currentDraft())"
            >
              <Save :size="16" aria-hidden="true" />
              Save
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="busy"
              @click="emit('execute', currentDraft())"
            >
              <Play :size="16" aria-hidden="true" />
              Send
            </button>
          </div>
        </div>

        <div class="target-row">
          <select
            v-model="method"
            class="method-control"
            aria-label="HTTP method"
            :disabled="busy"
          >
            <option v-for="option in methods" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
          <input
            v-model="targetUrl"
            class="url-input"
            aria-label="Target URL"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
          />
        </div>

        <div class="request-tabs" role="tablist" aria-label="Request settings">
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
            {{
              tab === "query" ? "Query" : tab[0]?.toUpperCase() + tab.slice(1)
            }}
            <span v-if="tab !== 'body'" class="tab-count">
              {{ tab === "query" ? query.length : headers.length }}
            </span>
          </button>
        </div>

        <div v-if="activeTab !== 'body'" class="request-fields">
          <div class="request-field-heading" aria-hidden="true">
            <span></span>
            <span>Name</span>
            <span>Value</span>
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
              :aria-label="`Enable ${activeTab} field ${index + 1}`"
              :disabled="busy"
            />
            <input
              v-model="field.name"
              class="field-cell-input"
              :aria-label="`${activeTab === 'query' ? 'Query' : 'Header'} name ${index + 1}`"
              placeholder="Name"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <input
              v-model="field.value"
              class="field-cell-input"
              :aria-label="`${activeTab === 'query' ? 'Query' : 'Header'} value ${index + 1}`"
              placeholder="Value"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <button
              class="icon-button compact-icon-button"
              type="button"
              :aria-label="`Remove ${activeTab} field ${index + 1}`"
              :title="`Remove ${activeTab} field`"
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
            Add {{ activeTab === "query" ? "parameter" : "header" }}
          </button>
        </div>

        <div v-else class="request-body-editor">
          <textarea
            v-model="body"
            class="raw-body-input"
            aria-label="Raw request body"
            placeholder="Raw request body"
            spellcheck="false"
            :disabled="busy"
          ></textarea>
        </div>
      </section>
      <ResponsePanel :execution="execution" />
    </template>
  </main>
</template>
