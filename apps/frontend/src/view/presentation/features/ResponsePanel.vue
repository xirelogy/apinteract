<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { Download, LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  formatDateTime,
  useDateTimeFormatPreference,
} from "@/app/preferences/date-time-format";
import {
  analyzeResponseContent,
  RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES,
} from "@/model/domain/response-content";
import type {
  ExecutionView,
  RequestExchangeSummary,
} from "@/model/contracts/backend";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import InfoPopover from "@/view/presentation/controls/InfoPopover.vue";
import SelectMenu, {
  type SelectMenuOption,
} from "@/view/presentation/controls/SelectMenu.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import HtmlResponsePreview from "@/view/presentation/features/HtmlResponsePreview.vue";
import ImageResponsePreview from "@/view/presentation/features/ImageResponsePreview.vue";

const CodeEditor = defineAsyncComponent(
  () => import("@/view/presentation/controls/CodeEditor.vue"),
);

const props = defineProps<{
  execution: ExecutionView | null;
  capturedResponse?: boolean;
  exchangeSummaries?: readonly RequestExchangeSummary[];
  selectedExchangeId?: string | null;
  loadBody?: ((executionId: string) => Promise<Blob>) | null;
}>();
const emit = defineEmits<{
  download: [executionId: string];
  selectExchange: [exchangeId: string];
}>();
const { locale, t } = useI18n();
const dateTimeFormatPreference = useDateTimeFormatPreference();

type ResponseDetailTab =
  | "error"
  | "request"
  | "raw"
  | "json"
  | "xml"
  | "html"
  | "image"
  | "headers"
  | "scripts";
const selectedTab = ref<ResponseDetailTab>("raw");

type ScriptLog = ExecutionView["scriptLogs"][number];
type ScriptTest = ExecutionView["scriptTests"][number];
type ScriptError = NonNullable<ExecutionView["scriptError"]>;
const scriptFailureCodes = new Set([
  "syntax_error",
  "runtime_error",
  "sdk_invalid_argument",
  "sdk_permission_denied",
  "sensitive_value_unavailable",
  "response_body_unavailable",
  "cpu_limit_exceeded",
  "memory_limit_exceeded",
  "time_limit_exceeded",
  "output_limit_exceeded",
  "cancelled",
]);
const scriptTestMessageCodes = new Set([
  "assertion_expected_truthy",
  "assertion_values_not_equal",
  "assertion_values_not_deeply_equal",
  "assertion_value_does_not_match",
  "test_threw_non_error",
]);
const executionFailureCodes = new Set(["execution_failed"]);
type ScriptResultCard =
  | {
      readonly type: "log";
      readonly sequence: number;
      readonly phase: ScriptLog["phase"];
      readonly log: ScriptLog;
    }
  | {
      readonly type: "test";
      readonly sequence: number;
      readonly phase: "post-response";
      readonly test: ScriptTest;
    }
  | {
      readonly type: "error";
      readonly sequence: number;
      readonly phase: ScriptError["phase"];
      readonly error: ScriptError;
    };

/** Merges script output into the order in which the SDK produced it. */
const scriptResultCards = computed<readonly ScriptResultCard[]>(() => {
  const execution = props.execution;
  if (execution === null) return [];
  const cards: ScriptResultCard[] = [
    ...execution.scriptLogs.map((log) => ({
      type: "log" as const,
      sequence: log.sequence,
      phase: log.phase,
      log,
    })),
    ...execution.scriptTests.map((test) => ({
      type: "test" as const,
      sequence: test.sequence,
      phase: "post-response" as const,
      test,
    })),
  ].sort((left, right) => left.sequence - right.sequence);
  if (execution.scriptError !== undefined) {
    cards.push({
      type: "error",
      sequence: (cards.at(-1)?.sequence ?? 0) + 1,
      phase: execution.scriptError.phase,
      error: execution.scriptError,
    });
  }
  return cards;
});

/** Reports whether the execution produced any inspectable HTTP response data. */
const hasResponseHead = computed(() => {
  const execution = props.execution;
  return (
    execution !== null &&
    (execution.status !== undefined || execution.headers !== undefined)
  );
});

/** Reports whether a failed execution retained an inspectable response body. */
const hasResponseBody = computed(() => {
  const execution = props.execution;
  return (
    execution !== null &&
    (execution.bodyPreview !== undefined || (execution.bodyBytes ?? 0) > 0)
  );
});

/** Classifies retained response evidence without fetching exact blob bytes. */
const content = computed(() =>
  props.execution === null
    ? null
    : analyzeResponseContent(props.execution, props.capturedResponse),
);

/** Exposes only successfully prepared or safely loadable derived body tabs. */
const derivedDetailTabs = computed<readonly ResponseDetailTab[]>(() => {
  const analysis = content.value;
  const execution = props.execution;
  if (analysis === null || execution === null) return [];
  if (analysis.kind === "json" && analysis.structured?.valid === true) {
    return ["json"];
  }
  if (analysis.kind === "xml" && analysis.structured?.valid === true) {
    return ["xml"];
  }
  if (analysis.kind === "html" && analysis.previewComplete) {
    return [
      ...(analysis.structured?.valid === true ? (["xml"] as const) : []),
      "html",
    ];
  }
  if (
    analysis.kind === "image" &&
    execution.bodyBlobId !== undefined &&
    props.loadBody != null &&
    (execution.bodyBytes ?? 0) <= RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES
  ) {
    return ["image"];
  }
  return [];
});

/** Reports a declared structured body that could not produce a parsed view. */
const hasInvalidStructuredBody = computed(
  () => content.value?.structured?.valid === false,
);

/** Reports an image that is retained but intentionally too large to preview. */
const imageExceedsPreviewLimit = computed(
  () =>
    content.value?.kind === "image" &&
    (props.execution?.bodyBytes ?? 0) > RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES,
);

/** Binds complete guarded image metadata to the lazy preview component. */
const imagePreview = computed(() => {
  const analysis = content.value;
  const execution = props.execution;
  const loadBody = props.loadBody;
  if (
    analysis?.kind !== "image" ||
    analysis.mediaType === null ||
    execution === null ||
    execution.bodyBytes === undefined ||
    loadBody == null
  ) {
    return null;
  }
  return {
    executionId: execution.executionId,
    mediaType: analysis.mediaType,
    byteLength: execution.bodyBytes,
    loadBody,
  };
});

/** Exposes data tabs backed by useful execution results after failure. */
const resultDetailTabs = computed<readonly ResponseDetailTab[]>(() => {
  const execution = props.execution;
  if (execution === null) return [];
  if (execution.error === undefined || execution.state === "running") {
    return [
      ...(execution.outgoingRequest === undefined
        ? ([] as const)
        : (["request"] as const)),
      "raw",
      ...derivedDetailTabs.value,
      "headers",
      "scripts",
    ];
  }
  return [
    ...(execution.outgoingRequest === undefined
      ? ([] as const)
      : (["request"] as const)),
    ...(hasResponseHead.value || hasResponseBody.value
      ? (["raw"] as const)
      : ([] as const)),
    ...derivedDetailTabs.value,
    ...(hasResponseHead.value ? (["headers"] as const) : ([] as const)),
    ...(scriptResultCards.value.length > 0
      ? (["scripts"] as const)
      : ([] as const)),
  ];
});

/** Places an execution error in a tab when other result data is available. */
const hasTabbedError = computed(
  () =>
    props.execution?.error !== undefined && resultDetailTabs.value.length > 0,
);

/** Orders the error before every retained request, response, or script result. */
const visibleDetailTabs = computed<readonly ResponseDetailTab[]>(() => [
  ...(hasTabbedError.value ? (["error"] as const) : ([] as const)),
  ...resultDetailTabs.value,
]);

/** Keeps an error-only execution in the compact tabless presentation. */
const showsStandaloneError = computed(
  () => props.execution?.error !== undefined && !hasTabbedError.value,
);

/** Formats history options with unambiguous timestamps and useful provenance. */
const exchangeOptions = computed<readonly SelectMenuOption[]>(() =>
  (props.exchangeSummaries ?? []).map((summary) => ({
    value: summary.exchangeId,
    label: [
      exchangeStatusLabel(summary),
      t(`response.exchange.kind.${summary.kind}`),
      ...(summary.source === "apinteract"
        ? []
        : [t(`response.exchange.source.${summary.source}`)]),
      formatExchangeDateTime(summary.occurredAt),
    ].join(" · "),
  })),
);

/** Formats one exchange instant as an exact locale-aware local date and time. */
function formatExchangeDateTime(occurredAt: string): string {
  return formatDateTime(
    occurredAt,
    locale.value,
    dateTimeFormatPreference.dateTimeFormat.value,
  );
}

/** Returns the response status or lifecycle label used by history options. */
function exchangeStatusLabel(summary: RequestExchangeSummary): string {
  if (summary.status !== undefined) return String(summary.status);
  return summary.state === "failed"
    ? t("response.exchange.failed")
    : summary.state === "completed"
      ? t("response.exchange.completed")
      : t("response.inProgress");
}

watch(
  () => [props.execution?.executionId, props.execution?.error !== undefined],
  () => {
    selectedTab.value = props.execution?.error === undefined ? "raw" : "error";
  },
  { immediate: true },
);

/** Keeps tab selection valid when a failed execution has limited results. */
const activeTab = computed<ResponseDetailTab>({
  get: () =>
    visibleDetailTabs.value.includes(selectedTab.value)
      ? selectedTab.value
      : (visibleDetailTabs.value[0] ?? "raw"),
  set: (tab) => {
    selectedTab.value = tab;
  },
});

/** Formats a byte count with locale-aware plural selection. */
function formatBytes(count: number): string {
  return t("response.bytes", { count }, count);
}

/** Localizes stable script failure codes while preserving unknown diagnostics. */
function localizeScriptCode(code: string): string {
  const failureCode = code.startsWith("script_")
    ? code.slice("script_".length)
    : code;
  return scriptFailureCodes.has(failureCode)
    ? t(`scripting.failure.${failureCode}`)
    : code;
}

/** Localizes stable execution failures while retaining unknown raw codes. */
function localizeExecutionCode(code: string): string {
  if (code.startsWith("script_")) return localizeScriptCode(code);
  return executionFailureCodes.has(code)
    ? t(`response.failure.${code}`)
    : t("response.failure.unknown");
}

/** Localizes SDK-generated test details without rewriting script-authored text. */
function formatTestMessage(test: ScriptTest): string {
  return test.messageCode !== undefined &&
    scriptTestMessageCodes.has(test.messageCode)
    ? t(`scripting.testMessage.${test.messageCode}`)
    : (test.message ?? "");
}

/** Formats only source coordinates actually reported by the script engine. */
function formatScriptLocation(error: ScriptError): string {
  if (error.line === undefined) return "";
  return error.column === undefined
    ? t("scripting.line", { line: error.line })
    : t("scripting.location", {
        line: error.line,
        column: error.column,
      });
}
</script>

<template>
  <section class="response-panel" aria-labelledby="response-heading">
    <div class="response-heading-row">
      <h2 id="response-heading">{{ t("response.heading") }}</h2>
      <SelectMenu
        v-if="exchangeOptions.length > 0"
        class="response-exchange-select"
        :model-value="selectedExchangeId ?? ''"
        :options="exchangeOptions"
        :label="t('response.exchange.label')"
        density="compact"
        @update:model-value="emit('selectExchange', $event)"
      />
      <div v-if="execution" class="response-metadata">
        <span v-if="capturedResponse" class="captured-response-badge">
          {{ t("response.captured") }}
        </span>
        <span
          v-if="execution.state === 'running'"
          class="execution-progress"
          role="status"
        >
          <LoaderCircle :size="14" aria-hidden="true" />
          {{ t("response.inProgress") }}
        </span>
        <span
          v-if="execution.state === 'running' || hasResponseHead"
          class="response-summary"
        >
          <span
            v-if="execution.status"
            class="status-code"
            :data-success="execution.status < 400"
          >
            {{ execution.status }}
          </span>
          <span>{{ formatBytes(execution.bodyBytes ?? 0) }}</span>
        </span>
        <IconButton
          v-if="execution.bodyBlobId && hasResponseHead"
          size="compact"
          :label="t('response.downloadBody')"
          :title="t('response.downloadBody')"
          @click="emit('download', execution.executionId)"
        >
          <Download :size="17" aria-hidden="true" />
        </IconButton>
      </div>
    </div>
    <div v-if="execution === null" class="response-empty">
      {{ t("response.empty") }}
    </div>
    <div
      v-else-if="showsStandaloneError && execution.error"
      class="execution-error"
      role="alert"
    >
      <strong>{{ localizeExecutionCode(execution.error.code) }}</strong>
      <code>{{ execution.error.code }}</code>
      <span>{{ execution.error.message }}</span>
    </div>
    <TabsRoot
      v-if="execution !== null && visibleDetailTabs.length > 0"
      v-model="activeTab"
      activation-mode="manual"
    >
      <TabsList class="response-tabs" :label="t('response.details')">
        <TabsTrigger
          v-if="visibleDetailTabs.includes('error')"
          class="tab-button"
          value="error"
        >
          {{ t("response.error") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('request')"
          class="tab-button"
          value="request"
        >
          {{ t("response.request") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('raw')"
          class="tab-button"
          value="raw"
        >
          {{ t("response.raw") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('json')"
          class="tab-button"
          value="json"
        >
          {{ t("response.json") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('xml')"
          class="tab-button"
          value="xml"
        >
          {{ t("response.xml") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('html')"
          class="tab-button"
          value="html"
        >
          {{ t("response.preview") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('image')"
          class="tab-button"
          value="image"
        >
          {{ t("response.image") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('headers')"
          class="tab-button"
          value="headers"
        >
          {{ t("response.headers") }}
          <span class="tab-count">{{ execution.headers?.length ?? 0 }}</span>
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('scripts')"
          class="tab-button"
          value="scripts"
        >
          {{ t("scripting.results") }}
          <span class="tab-count">{{ scriptResultCards.length }}</span>
        </TabsTrigger>
      </TabsList>
      <TabsPanel
        v-if="visibleDetailTabs.includes('error') && execution.error"
        value="error"
        class="response-content"
      >
        <div class="execution-error" role="alert">
          <strong>{{ localizeExecutionCode(execution.error.code) }}</strong>
          <code>{{ execution.error.code }}</code>
          <span>{{ execution.error.message }}</span>
        </div>
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('request')"
        value="request"
        class="response-content outgoing-request"
      >
        <div v-if="execution.outgoingRequest" class="outgoing-request-content">
          <div class="outgoing-request-line">
            <strong>{{ execution.outgoingRequest.method }}</strong>
            <code>{{ execution.outgoingRequest.url.value }}</code>
            <InfoPopover
              :label="
                t('common.actions.moreInformation', {
                  topic: t('response.request'),
                })
              "
            >
              {{ t("response.secretRedactionNote") }}
            </InfoPopover>
          </div>
          <section>
            <h3>{{ t("response.requestHeaders") }}</h3>
            <div
              v-for="(header, index) in execution.outgoingRequest.headers"
              :key="`${index}-${header.name}`"
              class="header-row"
            >
              <span>
                {{ header.name }}
                <small v-if="header.derived" class="derived-header-badge">
                  {{ t("response.derivedHeader") }}
                </small>
              </span>
              <span>{{ header.value }}</span>
            </div>
            <div
              v-if="execution.outgoingRequest.headers.length === 0"
              class="outgoing-request-empty"
            >
              {{ t("response.noRequestHeaders") }}
            </div>
          </section>
          <section>
            <h3>
              {{ t("response.requestBody") }}
              <small>
                {{ formatBytes(execution.outgoingRequest.body.byteLength) }}
                <template
                  v-if="execution.outgoingRequest.body.encoding === 'base64'"
                >
                  · {{ t("response.base64Encoded") }}
                </template>
                <template v-if="execution.outgoingRequest.body.truncated">
                  · {{ t("response.previewTruncated") }}
                </template>
              </small>
            </h3>
            <pre class="request-body-preview">{{
              execution.outgoingRequest.body.value || t("response.emptyBody")
            }}</pre>
          </section>
        </div>
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('headers')"
        value="headers"
        class="response-content"
      >
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
      <TabsPanel
        v-if="visibleDetailTabs.includes('raw')"
        value="raw"
        class="response-content"
      >
        <div v-if="execution.bodyPreview !== undefined" class="body-preview">
          <p
            v-if="content?.previewTruncated"
            class="response-preview-notice"
            role="status"
          >
            {{ t("response.previewTruncated") }}
          </p>
          <p
            v-if="hasInvalidStructuredBody"
            class="response-preview-notice"
            role="status"
          >
            {{
              t(
                content?.kind === "json"
                  ? "response.invalidJson"
                  : "response.invalidXml",
              )
            }}
          </p>
          <CodeEditor
            class="response-code-viewer"
            :model-value="execution.bodyPreview"
            :label="t('response.rawBody')"
            read-only
          />
        </div>
        <div v-else class="response-body-state">
          <strong v-if="execution.state === 'running'">
            {{ t("response.waitingBody") }}
          </strong>
          <strong v-else-if="content?.kind === 'empty'">
            {{ t("response.emptyResponseBody") }}
          </strong>
          <strong v-else-if="content?.kind === 'unavailable'">
            {{ t("response.capturedBodyUnavailable") }}
          </strong>
          <strong v-else>{{ t("response.binaryBody") }}</strong>
          <p v-if="imageExceedsPreviewLimit">
            {{ t("response.imageTooLarge") }}
          </p>
          <dl
            v-if="execution.state !== 'running'"
            class="response-body-metadata"
          >
            <div>
              <dt>{{ t("response.mediaType") }}</dt>
              <dd>
                {{ content?.mediaType ?? t("response.mediaTypeUnknown") }}
              </dd>
            </div>
            <div>
              <dt>{{ t("response.bodySize") }}</dt>
              <dd>{{ formatBytes(execution.bodyBytes ?? 0) }}</dd>
            </div>
            <div v-if="execution.bodySha256">
              <dt>{{ t("response.sha256") }}</dt>
              <dd>
                <code>{{ execution.bodySha256 }}</code>
              </dd>
            </div>
          </dl>
        </div>
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('json')"
        value="json"
        class="response-content response-body-view"
      >
        <CodeEditor
          v-if="content?.structured?.value !== undefined"
          class="response-code-viewer"
          :model-value="content.structured.value"
          :label="t('response.jsonBody')"
          language="json"
          read-only
          foldable
        />
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('xml')"
        value="xml"
        class="response-content response-body-view"
      >
        <CodeEditor
          v-if="content?.structured?.value !== undefined"
          class="response-code-viewer"
          :model-value="content.structured.value"
          :label="t('response.xmlBody')"
          language="xml"
          read-only
          foldable
        />
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('html')"
        value="html"
        class="response-content response-body-view"
      >
        <HtmlResponsePreview
          v-if="execution.bodyPreview !== undefined"
          :source="execution.bodyPreview"
          :title="t('response.htmlPreviewTitle')"
        />
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('image')"
        value="image"
        class="response-content response-body-view"
      >
        <ImageResponsePreview
          v-if="activeTab === 'image' && imagePreview !== null"
          :execution-id="imagePreview.executionId"
          :media-type="imagePreview.mediaType"
          :byte-length="imagePreview.byteLength"
          :load-body="imagePreview.loadBody"
        />
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('scripts')"
        value="scripts"
        class="response-content script-results"
      >
        <div
          v-for="card in scriptResultCards"
          :key="`${card.type}-${card.sequence}`"
          class="script-result-card"
          :data-kind="card.type"
          :data-status="
            card.type === 'test'
              ? card.test.status
              : card.type === 'log'
                ? card.log.level
                : 'error'
          "
          :role="card.type === 'error' ? 'alert' : undefined"
        >
          <div class="script-result-card-header">
            <span class="script-result-kind">
              {{ t(`scripting.eventType.${card.type}`) }}
            </span>
            <span>{{ t(`scripting.phase.${card.phase}`) }}</span>
            <strong v-if="card.type === 'log'">
              {{ t(`scripting.logLevel.${card.log.level}`) }}
            </strong>
            <strong v-else-if="card.type === 'test'">
              {{ t(`scripting.testStatus.${card.test.status}`) }}
            </strong>
            <strong v-else>{{ localizeScriptCode(card.error.code) }}</strong>
            <code v-if="card.type === 'error'" class="script-result-code">
              {{ card.error.code }}
            </code>
          </div>
          <template v-if="card.type === 'log'">
            <code class="script-result-message">{{ card.log.message }}</code>
            <pre v-if="card.log.fields">{{
              JSON.stringify(card.log.fields, null, 2)
            }}</pre>
          </template>
          <template v-else-if="card.type === 'test'">
            <strong class="script-result-message">{{ card.test.name }}</strong>
            <small v-if="card.test.message || card.test.messageCode">
              {{ formatTestMessage(card.test) }}
            </small>
          </template>
          <template v-else>
            <span class="script-result-message">{{ card.error.message }}</span>
            <small v-if="card.error.line">
              {{ formatScriptLocation(card.error) }}
            </small>
          </template>
        </div>
        <div v-if="!scriptResultCards.length" class="response-detail-empty">
          {{
            execution.state === "running"
              ? t("scripting.waitingResults")
              : t("scripting.noResults")
          }}
        </div>
      </TabsPanel>
    </TabsRoot>
  </section>
</template>
