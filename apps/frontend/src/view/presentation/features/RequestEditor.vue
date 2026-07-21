<script setup lang="ts">
import { ref, watch } from "vue";
import { Play, Save } from "@lucide/vue";

import type { ExecutionView, RequestView } from "@/model/contracts/backend";
import ResponsePanel from "./ResponsePanel.vue";

const props = defineProps<{
  request: RequestView | null;
  execution: ExecutionView | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  save: [name: string, targetUrl: string];
  execute: [name: string, targetUrl: string];
}>();

const name = ref("");
const targetUrl = ref("");

watch(
  () => props.request,
  (request) => {
    name.value = request?.name ?? "";
    targetUrl.value = request?.targetUrl ?? "";
  },
  { immediate: true },
);
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
          <input
            id="request-name"
            v-model="name"
            class="request-name-input"
            aria-label="Request name"
            :disabled="busy"
          />
          <div class="command-bar">
            <button
              class="secondary-button"
              type="button"
              :disabled="busy"
              @click="emit('save', name, targetUrl)"
            >
              <Save :size="16" aria-hidden="true" />
              Save
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="busy"
              @click="emit('execute', name, targetUrl)"
            >
              <Play :size="16" aria-hidden="true" />
              Send
            </button>
          </div>
        </div>
        <div class="target-row">
          <span class="method-control">GET</span>
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
          <button class="tab-button is-active" type="button" role="tab">
            Request
          </button>
        </div>
        <div class="request-summary">
          <dl>
            <div>
              <dt>Target mode</dt>
              <dd>Absolute</dd>
            </div>
            <div>
              <dt>Query mode</dt>
              <dd>Structured</dd>
            </div>
            <div>
              <dt>Draft revision</dt>
              <dd>{{ request.draftRevision }}</dd>
            </div>
          </dl>
        </div>
      </section>
      <ResponsePanel :execution="execution" />
    </template>
  </main>
</template>
