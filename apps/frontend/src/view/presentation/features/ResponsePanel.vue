<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  formatDateTime,
  useDateTimeFormatPreference,
} from "@/app/preferences/date-time-format";
import { frontendPluginRuntime } from "@/app/plugins/frontend-plugin-host";
import {
  localizePluginLabel,
  useFrontendPluginUi,
} from "@/app/plugins/frontend-plugin-ui";
import { analyzeResponseContent } from "@/model/domain/response-content";
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
import PluginViewHost from "@/view/presentation/controls/PluginViewHost.vue";

const CodeEditor = defineAsyncComponent(
  () => import("@/view/presentation/controls/CodeEditor.vue"),
);

const props = defineProps<{
  execution: ExecutionView | null;
  capturedResponse?: boolean;
  exchangeSummaries?: readonly RequestExchangeSummary[];
  selectedExchangeId?: string | null;
  loadBody?: ((executionId: string) => Promise<Blob>) | null;
  downloadTransportCertificate?:
    | ((executionId: string, sha256Fingerprint: string) => void)
    | null;
}>();
const emit = defineEmits<{
  download: [executionId: string];
  selectExchange: [exchangeId: string];
  selectExecutionExchange: [executionId: string];
}>();
const i18n = useI18n();
const { locale, t } = i18n;
const pluginUi = useFrontendPluginUi();
const dateTimeFormatPreference = useDateTimeFormatPreference();

type CoreResponseDetailTab =
  | "error"
  | "request"
  | "raw"
  | "headers"
  | "connection"
  | "scripts";
type ResponseDetailTab = CoreResponseDetailTab | `viewer:${string}`;
const selectedTab = ref<ResponseDetailTab>("raw");

type ScriptLog = ExecutionView["scriptLogs"][number];
type ScriptTest = ExecutionView["scriptTests"][number];
type ScriptError = NonNullable<ExecutionView["scriptError"]>;
type ScriptVariableWrite = NonNullable<
  ExecutionView["scriptVariableWrites"]
>[number];
type TlsTransportMetadata = NonNullable<
  NonNullable<ExecutionView["transportMetadata"]>["tls"]
>;
type TransportCertificateSummary = NonNullable<
  TlsTransportMetadata["peerCertificateChain"]
>[number];
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
  "variable_write_conflict",
  "variable_write_denied",
  "cancelled",
]);
const scriptTestMessageCodes = new Set([
  "assertion_expected_truthy",
  "assertion_values_not_equal",
  "assertion_values_not_deeply_equal",
  "assertion_value_does_not_match",
  "test_threw_non_error",
]);
const executionFailureCodes = new Set([
  "execution_failed",
  "execution_timeout",
  "redirect_body_not_replayable",
  "redirect_credentials_not_allowed",
  "redirect_disabled",
  "redirect_insecure_downgrade",
  "redirect_invalid_location",
  "redirect_limit_exceeded",
  "redirect_unsupported_scheme",
  "response_size_limit",
]);
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
    }
  | {
      readonly type: "variable";
      readonly sequence: number;
      readonly phase: "post-response";
      readonly write: ScriptVariableWrite;
    };

/** Merges script output with value-free receipts for committed mutations. */
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
  const writeSequenceOffset = cards.at(-1)?.sequence ?? 0;
  cards.push(
    ...(execution.scriptVariableWrites ?? []).map((write, index) => ({
      type: "variable" as const,
      sequence: writeSequenceOffset + index + 1,
      phase: "post-response" as const,
      write,
    })),
  );
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

/** Reports whether a terminal APInteract execution has connection results to show. */
const hasConnectionResult = computed(() => {
  const execution = props.execution;
  return (
    execution !== null &&
    props.capturedResponse !== true &&
    execution.state !== "created" &&
    execution.state !== "running" &&
    (execution.timings !== undefined ||
      execution.transportMetadataCollected ||
      execution.transportMetadataUnavailableReason !== undefined ||
      execution.transportMetadata !== undefined)
  );
});

/** Reports whether a connection result contains no displayable observation. */
const hasNoConnectionData = computed(
  () =>
    props.execution?.timings === undefined &&
    props.execution?.transportMetadata === undefined &&
    props.execution?.transportMetadataUnavailableReason === undefined,
);

/** Classifies retained response evidence without fetching exact blob bytes. */
const content = computed(() =>
  props.execution === null
    ? null
    : analyzeResponseContent(
        props.execution,
        props.capturedResponse,
        frontendPluginRuntime.responseContent,
        props.loadBody ?? undefined,
        locale.value,
      ),
);

/** Exposes the selected executable plugin viewer as one generic detail tab. */
const derivedDetailTabs = computed<readonly ResponseDetailTab[]>(() => {
  const viewer = content.value?.viewer;
  return viewer === undefined ? [] : [`viewer:${viewer.id}`];
});

/** Localizes one plugin label while retaining its package-provided fallback. */
function viewerLabel(): string {
  const label = content.value?.viewer?.label;
  if (label === undefined) return "";
  return localizePluginLabel(label, locale.value);
}

const viewerContext = computed(() => {
  const analysis = content.value;
  const execution = props.execution;
  if (
    analysis?.viewer === undefined ||
    execution === null ||
    analysis.mediaType === null
  ) {
    return null;
  }
  return {
    execution,
    mediaType: analysis.mediaType,
    locale: locale.value,
    previewComplete: analysis.previewComplete,
    previewTruncated: analysis.previewTruncated,
    ...(props.loadBody == null ? {} : { loadBody: props.loadBody }),
    ui: pluginUi,
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
      ...(hasConnectionResult.value ? (["connection"] as const) : []),
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
    ...(hasConnectionResult.value ? (["connection"] as const) : ([] as const)),
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

/** Chooses a parsed structured body view before falling back to the raw body. */
const defaultDetailTab = computed<ResponseDetailTab>(() => {
  if (props.execution?.error !== undefined) return "error";
  const viewer = content.value?.viewer;
  return viewer !== undefined && content.value?.viewerIsDefault === true
    ? `viewer:${viewer.id}`
    : "raw";
});

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
      summary.label ?? t(`response.exchange.kind.${summary.kind}`),
      formatExchangeDateTime(summary.occurredAt),
    ].join(" · "),
  })),
);

/** Returns the ordered redirect exchanges attached to the selected execution. */
const redirectChain = computed(() => props.execution?.redirectChain ?? []);

/** Locates the displayed exchange inside its redirect chain. */
const redirectChainIndex = computed(() =>
  redirectChain.value.findIndex(
    (item) => item.exchangeId === props.execution?.executionId,
  ),
);

/** Formats redirect exchanges for the complete-chain selection menu. */
const redirectChainOptions = computed<readonly SelectMenuOption[]>(() =>
  redirectChain.value.map((item, index) => ({
    value: item.exchangeId,
    label: [
      `${index + 1} / ${redirectChain.value.length}`,
      item.status ?? t("response.redirect.noStatus"),
      item.method,
      item.url.value,
      ...(item.final ? [t("response.redirect.final")] : []),
    ].join(" · "),
  })),
);

/** Selects the previous or next exchange without wrapping the redirect chain. */
function selectAdjacentRedirectExchange(offset: -1 | 1): void {
  const item = redirectChain.value[redirectChainIndex.value + offset];
  if (item !== undefined) emit("selectExecutionExchange", item.exchangeId);
}

/** Selects a linked redirect exchange when the relationship has a target. */
function selectLinkedRedirectExchange(executionId: string | undefined): void {
  if (executionId !== undefined) emit("selectExecutionExchange", executionId);
}

/** Returns the redirect source immediately before the displayed exchange. */
const redirectSource = computed(() =>
  redirectChainIndex.value > 0
    ? redirectChain.value[redirectChainIndex.value - 1]
    : undefined,
);

/** Displays a resolved redirect target while retaining malformed raw evidence. */
const displayedRedirectLocation = computed(
  () =>
    props.execution?.redirect?.resolvedLocation?.value ??
    props.execution?.redirect?.location ??
    "",
);

/** Indicates when redirect context occupies its own layout row. */
const showsRedirectSummary = computed(
  () =>
    props.execution !== null &&
    (props.execution.redirect !== undefined ||
      redirectSource.value !== undefined),
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
  () => [
    props.execution?.executionId,
    props.execution?.error !== undefined,
    defaultDetailTab.value,
  ],
  () => {
    selectedTab.value = defaultDetailTab.value;
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

/** Formats one observed duration without implying unavailable phase precision. */
function formatDuration(milliseconds: number): string {
  return t("response.connection.milliseconds", {
    value: new Intl.NumberFormat(locale.value, {
      maximumFractionDigits: 2,
    }).format(milliseconds),
  });
}

/** Formats an endpoint while keeping IPv6 addresses visually unambiguous. */
function formatEndpoint(endpoint: {
  readonly address: string;
  readonly port: number;
  readonly family: "ipv4" | "ipv6";
}): string {
  return endpoint.family === "ipv6"
    ? `[${endpoint.address}]:${endpoint.port}`
    : `${endpoint.address}:${endpoint.port}`;
}

/** Returns the localized strict-verification result for the observed TLS peer. */
function tlsAuthorizationLabel(tls: TlsTransportMetadata): string {
  if (tls.authorized === true) return t("response.connection.authorized");
  if (tls.authorizationErrorCode !== undefined) {
    return t(
      `response.connection.authorizationError.${tls.authorizationErrorCode}`,
    );
  }
  return t("response.connection.authorizationUnknown");
}

/** Returns the preferred standardized name for an observed TLS cipher. */
function tlsCipherLabel(cipher: TlsTransportMetadata["cipher"]): string {
  return cipher?.standardName ?? cipher?.name ?? "";
}

/** Displays a nullable TLS negotiation value consistently. */
function optionalTlsValue(value: string | null): string {
  return value ?? t("response.connection.none");
}

/** Returns the localized position label for one peer certificate. */
function certificateLabel(certificate: TransportCertificateSummary): string {
  return certificate.chainPosition === 0
    ? t("response.connection.leafCertificate")
    : t("response.connection.chainCertificate", {
        position: certificate.chainPosition + 1,
      });
}

/** Requests an authenticated PEM download for one observed certificate. */
function downloadCertificate(sha256Fingerprint: string): void {
  const execution = props.execution;
  if (execution === null) return;
  props.downloadTransportCertificate?.(
    execution.executionId,
    sha256Fingerprint,
  );
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
function formatScriptLocation(error: {
  readonly line?: number;
  readonly column?: number;
}): string {
  if (error.line === undefined) return "";
  return error.column === undefined
    ? t("scripting.line", { line: error.line })
    : t("scripting.location", {
        line: error.line,
        column: error.column,
      });
}

/** Adds safe error code and source coordinates to an in-test diagnostic. */
function formatTestDiagnostic(test: ScriptTest): string {
  const message = formatTestMessage(test);
  const knownMessage =
    test.messageCode !== undefined &&
    scriptTestMessageCodes.has(test.messageCode);
  const parts = [message];
  if (
    test.code !== undefined &&
    !knownMessage &&
    test.code !== "runtime_error"
  ) {
    parts.push(test.code);
  }
  if (test.line !== undefined) parts.push(formatScriptLocation(test));
  return parts.filter((part) => part !== "").join(" · ");
}
</script>

<template>
  <section
    class="response-panel"
    :class="{ 'has-redirect-summary': showsRedirectSummary }"
    aria-labelledby="response-heading"
  >
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
    <div
      v-if="execution !== null && showsRedirectSummary"
      class="response-redirect-summary"
    >
      <div v-if="redirectChain.length > 1" class="redirect-chain-navigation">
        <IconButton
          size="compact"
          :label="t('response.redirect.previous')"
          :title="t('response.redirect.previous')"
          :disabled="redirectChainIndex <= 0"
          @click="selectAdjacentRedirectExchange(-1)"
        >
          <ChevronLeft :size="16" aria-hidden="true" />
        </IconButton>
        <SelectMenu
          class="redirect-chain-select"
          :model-value="execution.executionId"
          :options="redirectChainOptions"
          :label="t('response.redirect.chain')"
          density="compact"
          @update:model-value="emit('selectExecutionExchange', $event)"
        >
          <template #selected>
            {{ redirectChainIndex + 1 }} / {{ redirectChain.length }}
          </template>
        </SelectMenu>
        <IconButton
          size="compact"
          :label="t('response.redirect.next')"
          :title="t('response.redirect.next')"
          :disabled="redirectChainIndex >= redirectChain.length - 1"
          @click="selectAdjacentRedirectExchange(1)"
        >
          <ChevronRight :size="16" aria-hidden="true" />
        </IconButton>
      </div>
      <div v-if="execution.redirect" class="response-redirect-details">
        <IconButton
          v-if="execution.redirect.destinationExecutionId"
          size="compact"
          :label="t('response.redirect.destination')"
          :title="t('response.redirect.destination')"
          @click="
            selectLinkedRedirectExchange(
              execution.redirect?.destinationExecutionId,
            )
          "
        >
          <ArrowRight :size="16" aria-hidden="true" />
        </IconButton>
        <code>{{ displayedRedirectLocation }}</code>
        <span v-if="execution.redirect.reason" class="response-redirect-reason">
          {{ localizeExecutionCode(execution.redirect.reason) }}
        </span>
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
          key="error"
          class="tab-button"
          value="error"
        >
          {{ t("response.error") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('request')"
          key="request"
          class="tab-button"
          value="request"
        >
          {{ t("response.request") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('raw')"
          key="raw"
          class="tab-button"
          value="raw"
        >
          {{ t("response.raw") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="content?.viewer !== undefined"
          :key="`viewer:${content.viewer.id}`"
          class="tab-button"
          :value="`viewer:${content.viewer.id}`"
        >
          {{ viewerLabel() }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('headers')"
          key="headers"
          class="tab-button"
          value="headers"
        >
          {{ t("response.headers") }}
          <span class="tab-count">{{ execution.headers?.length ?? 0 }}</span>
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('connection')"
          key="connection"
          class="tab-button"
          value="connection"
        >
          {{ t("response.connection.tab") }}
        </TabsTrigger>
        <TabsTrigger
          v-if="visibleDetailTabs.includes('scripts')"
          key="scripts"
          class="tab-button"
          value="scripts"
        >
          {{ t("scripting.results") }}
          <span class="tab-count">{{ scriptResultCards.length }}</span>
        </TabsTrigger>
      </TabsList>
      <TabsPanel
        v-if="visibleDetailTabs.includes('error') && execution.error"
        key="error"
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
        key="request"
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
              <small class="script-result-variable-target">
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
        key="headers"
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
        v-if="visibleDetailTabs.includes('connection')"
        key="connection"
        value="connection"
        class="response-content connection-results"
      >
        <p
          v-if="execution.transportMetadataUnavailableReason !== undefined"
          class="response-detail-notice"
        >
          {{
            t(
              "response.connection.unavailable." +
                execution.transportMetadataUnavailableReason,
            )
          }}
        </p>
        <section v-if="execution.timings !== undefined">
          <h3>{{ t("response.connection.timings") }}</h3>
          <dl class="connection-metadata">
            <div v-if="execution.timings.dnsMs !== undefined">
              <dt>{{ t("response.connection.dns") }}</dt>
              <dd>{{ formatDuration(execution.timings.dnsMs) }}</dd>
            </div>
            <div v-if="execution.timings.connectMs !== undefined">
              <dt>{{ t("response.connection.connect") }}</dt>
              <dd>{{ formatDuration(execution.timings.connectMs) }}</dd>
            </div>
            <div v-if="execution.timings.tlsMs !== undefined">
              <dt>{{ t("response.connection.tlsHandshake") }}</dt>
              <dd>{{ formatDuration(execution.timings.tlsMs) }}</dd>
            </div>
            <div v-if="execution.timings.firstByteMs !== undefined">
              <dt>{{ t("response.connection.firstByte") }}</dt>
              <dd>{{ formatDuration(execution.timings.firstByteMs) }}</dd>
            </div>
            <div>
              <dt>{{ t("response.connection.total") }}</dt>
              <dd>{{ formatDuration(execution.timings.totalMs) }}</dd>
            </div>
          </dl>
        </section>
        <section v-if="execution.transportMetadata !== undefined">
          <h3>{{ t("response.connection.connection") }}</h3>
          <dl class="connection-metadata">
            <div
              v-if="execution.transportMetadata.remoteEndpoint !== undefined"
            >
              <dt>{{ t("response.connection.remoteEndpoint") }}</dt>
              <dd>
                <code>{{
                  formatEndpoint(execution.transportMetadata.remoteEndpoint)
                }}</code>
              </dd>
            </div>
            <div
              v-if="execution.transportMetadata.connectionReused !== undefined"
            >
              <dt>{{ t("response.connection.reused") }}</dt>
              <dd>
                {{
                  execution.transportMetadata.connectionReused
                    ? t("response.connection.yes")
                    : t("response.connection.no")
                }}
              </dd>
            </div>
          </dl>
        </section>
        <section v-if="execution.transportMetadata?.tls !== undefined">
          <h3>{{ t("response.connection.tls") }}</h3>
          <dl class="connection-metadata">
            <div>
              <dt>{{ t("response.connection.verificationMode") }}</dt>
              <dd>
                {{
                  t(
                    "response.connection.verification." +
                      execution.transportMetadata.tls.verificationMode,
                  )
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t("response.connection.authorization") }}</dt>
              <dd>
                {{ tlsAuthorizationLabel(execution.transportMetadata.tls) }}
              </dd>
            </div>
            <div v-if="execution.transportMetadata.tls.protocol !== undefined">
              <dt>{{ t("response.connection.protocol") }}</dt>
              <dd>{{ execution.transportMetadata.tls.protocol }}</dd>
            </div>
            <div v-if="execution.transportMetadata.tls.cipher !== undefined">
              <dt>{{ t("response.connection.cipher") }}</dt>
              <dd>
                <code>{{
                  tlsCipherLabel(execution.transportMetadata.tls.cipher)
                }}</code>
              </dd>
            </div>
            <div
              v-if="execution.transportMetadata.tls.alpnProtocol !== undefined"
            >
              <dt>{{ t("response.connection.alpn") }}</dt>
              <dd>
                {{
                  optionalTlsValue(execution.transportMetadata.tls.alpnProtocol)
                }}
              </dd>
            </div>
            <div
              v-if="execution.transportMetadata.tls.serverName !== undefined"
            >
              <dt>{{ t("response.connection.serverName") }}</dt>
              <dd>
                {{
                  optionalTlsValue(execution.transportMetadata.tls.serverName)
                }}
              </dd>
            </div>
          </dl>
        </section>
        <section
          v-if="
            (execution.transportMetadata?.tls?.peerCertificateChain?.length ??
              0) > 0
          "
          class="certificate-chain"
        >
          <h3>{{ t("response.connection.certificates") }}</h3>
          <p
            v-if="
              execution.transportMetadata?.tls
                ?.peerCertificateChainCaptureComplete === false
            "
            class="response-detail-notice"
          >
            {{
              t("response.connection.certificatesIncomplete", {
                count:
                  execution.transportMetadata.tls.omittedPeerCertificateCount ??
                  0,
              })
            }}
          </p>
          <article
            v-for="certificate in execution.transportMetadata?.tls
              ?.peerCertificateChain ?? []"
            :key="certificate.sha256Fingerprint"
            class="certificate-card"
          >
            <div class="certificate-card-heading">
              <strong>{{ certificateLabel(certificate) }}</strong>
              <IconButton
                v-if="downloadTransportCertificate != null"
                size="compact"
                :label="t('response.connection.downloadCertificate')"
                :title="t('response.connection.downloadCertificate')"
                @click="downloadCertificate(certificate.sha256Fingerprint)"
              >
                <Download :size="16" aria-hidden="true" />
              </IconButton>
            </div>
            <dl class="connection-metadata certificate-metadata">
              <div v-if="certificate.subject !== undefined">
                <dt>{{ t("response.connection.subject") }}</dt>
                <dd>{{ certificate.subject }}</dd>
              </div>
              <div v-if="certificate.issuer !== undefined">
                <dt>{{ t("response.connection.issuer") }}</dt>
                <dd>{{ certificate.issuer }}</dd>
              </div>
              <div v-if="certificate.validFrom !== undefined">
                <dt>{{ t("response.connection.validFrom") }}</dt>
                <dd>{{ formatExchangeDateTime(certificate.validFrom) }}</dd>
              </div>
              <div v-if="certificate.validTo !== undefined">
                <dt>{{ t("response.connection.validTo") }}</dt>
                <dd>{{ formatExchangeDateTime(certificate.validTo) }}</dd>
              </div>
              <div v-if="certificate.serialNumber !== undefined">
                <dt>{{ t("response.connection.serialNumber") }}</dt>
                <dd>
                  <code>{{ certificate.serialNumber }}</code>
                </dd>
              </div>
              <div>
                <dt>{{ t("response.connection.fingerprint") }}</dt>
                <dd>
                  <code>{{ certificate.sha256Fingerprint }}</code>
                </dd>
              </div>
              <div
                v-if="certificate.subjectAlternativeNames?.length"
                class="certificate-wide-field"
              >
                <dt>{{ t("response.connection.subjectAlternativeNames") }}</dt>
                <dd>{{ certificate.subjectAlternativeNames.join(", ") }}</dd>
              </div>
            </dl>
          </article>
        </section>
        <div v-if="hasNoConnectionData" class="response-detail-empty">
          {{ t("response.connection.noData") }}
        </div>
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('raw')"
        key="raw"
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
          <strong v-else-if="content?.state === 'empty'">
            {{ t("response.emptyResponseBody") }}
          </strong>
          <strong v-else-if="content?.state === 'unavailable'">
            {{ t("response.capturedBodyUnavailable") }}
          </strong>
          <strong v-else>{{ t("response.binaryBody") }}</strong>
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
        v-if="content?.viewer !== undefined && viewerContext !== null"
        :key="`viewer:${content.viewer.id}`"
        :value="`viewer:${content.viewer.id}`"
        class="response-content response-body-view"
      >
        <PluginViewHost
          v-if="activeTab === `viewer:${content.viewer.id}`"
          :mount="content.viewer.mountView"
          :context="viewerContext"
        />
      </TabsPanel>
      <TabsPanel
        v-if="visibleDetailTabs.includes('scripts')"
        key="scripts"
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
                : card.type === 'variable'
                  ? 'passed'
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
            <strong v-else-if="card.type === 'variable'">
              {{ t("scripting.variableWrite.saved") }}
            </strong>
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
            <small v-if="formatTestDiagnostic(card.test)">
              {{ formatTestDiagnostic(card.test) }}
            </small>
          </template>
          <template v-else-if="card.type === 'variable'">
            <div class="script-result-variable-details">
              <code>{{ card.write.name }}</code>
              <small>
                {{ t(`scripting.variableWrite.scope.${card.write.scope}`) }} ·
                {{ t(`scripting.variableWrite.kind.${card.write.kind}`) }}
              </small>
            </div>
          </template>
          <template v-else>
            <div class="script-result-error-details">
              <strong class="script-result-summary">
                {{ localizeScriptCode(card.error.code) }}
              </strong>
              <span class="script-result-message">
                {{ ` — ${card.error.message}` }}
              </span>
              <small v-if="card.error.line">
                · {{ formatScriptLocation(card.error) }}
              </small>
            </div>
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
