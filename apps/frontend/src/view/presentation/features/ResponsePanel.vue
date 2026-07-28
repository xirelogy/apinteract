<script setup lang="ts">
import { ref } from "vue";
import { Download, LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { ExecutionView } from "@/model/contracts/backend";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";

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
    <TabsRoot v-else v-model="activeTab" activation-mode="manual">
      <TabsList class="response-tabs" :label="t('response.details')">
        <TabsTrigger class="tab-button" value="raw">
          {{ t("response.raw") }}
        </TabsTrigger>
        <TabsTrigger class="tab-button" value="headers">
          {{ t("response.headers") }}
          <span class="tab-count">{{ execution.headers?.length ?? 0 }}</span>
        </TabsTrigger>
      </TabsList>
      <TabsPanel value="headers" class="response-content">
        <div class="response-headers">
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
      </TabsPanel>
      <TabsPanel value="raw" class="response-content">
        <pre class="body-preview">{{
          execution.bodyPreview ??
          (execution.state === "running"
            ? t("response.waitingBody")
            : t("response.binaryBody"))
        }}</pre>
      </TabsPanel>
    </TabsRoot>
  </section>
</template>
