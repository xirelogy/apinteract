<script setup lang="ts">
import { Download } from "@lucide/vue";

import type { ExecutionView } from "@/model/contracts/backend";

defineProps<{
  execution: ExecutionView | null;
}>();
</script>

<template>
  <section class="response-panel" aria-labelledby="response-heading">
    <div class="response-heading-row">
      <h2 id="response-heading">Response</h2>
      <div v-if="execution" class="response-metadata">
        <span
          v-if="execution.status"
          class="status-code"
          :data-success="execution.status < 400"
        >
          {{ execution.status }}
        </span>
        <span>{{ execution.bodyBytes ?? 0 }} bytes</span>
        <a
          v-if="execution.bodyBlobId"
          class="icon-button"
          :href="`/api/executions/${execution.executionId}/body`"
          title="Download response body"
          aria-label="Download response body"
        >
          <Download :size="17" aria-hidden="true" />
        </a>
      </div>
    </div>
    <div v-if="execution === null" class="response-empty">
      Send the request to inspect its response.
    </div>
    <div v-else-if="execution.error" class="execution-error" role="alert">
      <strong>{{ execution.error.code }}</strong>
      <span>{{ execution.error.message }}</span>
    </div>
    <div v-else class="response-content">
      <div class="response-headers">
        <div
          v-for="(header, index) in execution.headers ?? []"
          :key="`${index}-${header.name}`"
          class="header-row"
        >
          <span>{{ header.name }}</span>
          <span>{{ header.value }}</span>
        </div>
      </div>
      <pre class="body-preview">{{
        execution.bodyPreview ?? "Binary or non-previewable response body."
      }}</pre>
    </div>
  </section>
</template>
