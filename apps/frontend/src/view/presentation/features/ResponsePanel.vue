<script setup lang="ts">
import { ref } from "vue";
import { Download, LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { ExecutionView } from "@/model/contracts/backend";

defineProps<{
  execution: ExecutionView | null;
}>();
const { t } = useI18n();

const activeTab = ref<"headers" | "raw">("raw");

/** Formats a byte count with locale-aware plural selection. */
function formatBytes(count: number): string {
  return t("response.bytes", { count }, count);
}
</script>

<template>
  <section class="response-panel" aria-labelledby="response-heading">
    <div class="response-heading-row">
      <h2 id="response-heading">{{ t("response.heading") }}</h2>
      <div v-if="execution" class="response-metadata">
        <span
          v-if="execution.state === 'running'"
          class="execution-progress"
          role="status"
        >
          <LoaderCircle :size="14" aria-hidden="true" />
          {{ t("response.inProgress") }}
        </span>
        <span class="response-summary">
          <span
            v-if="execution.status"
            class="status-code"
            :data-success="execution.status < 400"
          >
            {{ execution.status }}
          </span>
          <span>{{ formatBytes(execution.bodyBytes ?? 0) }}</span>
        </span>
        <a
          v-if="execution.bodyBlobId"
          class="icon-button"
          :href="`/api/executions/${execution.executionId}/body`"
          :title="t('response.downloadBody')"
          :aria-label="t('response.downloadBody')"
        >
          <Download :size="17" aria-hidden="true" />
        </a>
      </div>
    </div>
    <div v-if="execution === null" class="response-empty">
      {{ t("response.empty") }}
    </div>
    <div v-else-if="execution.error" class="execution-error" role="alert">
      <strong>{{ execution.error.code }}</strong>
      <span>{{ execution.error.message }}</span>
    </div>
    <template v-else>
      <div
        class="response-tabs"
        role="tablist"
        :aria-label="t('response.details')"
      >
        <button
          class="tab-button"
          :class="{ 'is-active': activeTab === 'raw' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'raw'"
          @click="activeTab = 'raw'"
        >
          {{ t("response.raw") }}
        </button>
        <button
          class="tab-button"
          :class="{ 'is-active': activeTab === 'headers' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'headers'"
          @click="activeTab = 'headers'"
        >
          {{ t("response.headers") }}
          <span class="tab-count">{{ execution.headers?.length ?? 0 }}</span>
        </button>
      </div>
      <div class="response-content">
        <div v-if="activeTab === 'headers'" class="response-headers">
          <div
            v-for="(header, index) in execution.headers ?? []"
            :key="`${index}-${header.name}`"
            class="header-row"
          >
            <span>{{ header.name }}</span>
            <span>{{ header.value }}</span>
          </div>
          <div v-if="!execution.headers?.length" class="response-detail-empty">
            {{
              execution.state === "running"
                ? t("response.waitingHeaders")
                : t("response.noHeaders")
            }}
          </div>
        </div>
        <pre v-else class="body-preview">{{
          execution.bodyPreview ??
          (execution.state === "running"
            ? t("response.waitingBody")
            : t("response.binaryBody"))
        }}</pre>
      </div>
    </template>
  </section>
</template>
