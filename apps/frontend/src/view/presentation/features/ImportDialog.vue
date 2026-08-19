<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ChevronRight,
  CircleAlert,
  FileUp,
  Info,
  TriangleAlert,
  X,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  ImportApplyResult,
  ImportPlan,
  ImportProviderId,
  ImportProviderManifest,
  ImportProvidersView,
  ImportedRequest,
} from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";

type ImportDestination = "temporary" | "workspace" | "collection";
const DIAGNOSTIC_SEVERITY_ORDER = ["error", "warning", "info"] as const;
const MAX_IMPORT_SOURCE_BYTES = 524_288;

const props = defineProps<{
  selectedCollectionId: string | null;
  selectedCollectionName: string | null;
  busy: boolean;
  listProviders: () => Promise<ImportProvidersView>;
  previewImport: (
    providerId: ImportProviderId | null,
    sourceName: string,
    sourceText: string,
  ) => Promise<ImportPlan>;
  applyImport: (options: {
    readonly providerId: ImportProviderId | null;
    readonly sourceName: string;
    readonly sourceText: string;
    readonly plan: ImportPlan;
    readonly selectedItemIds: readonly string[];
    readonly collectionName: string;
    readonly parentCollectionId: string | null;
  }) => Promise<ImportApplyResult>;
  openTemporary: (plan: ImportPlan, request: ImportedRequest) => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const open = ref(true);
const providers = ref<readonly ImportProviderManifest[]>([]);
const providerValue = ref("");
const sourceInput = ref<HTMLInputElement | null>(null);
const sourceName = ref("");
const sourceText = ref("");
const plan = ref<ImportPlan | null>(null);
const selectedItemIds = ref<string[]>([]);
const destination = ref<ImportDestination>("workspace");
const collectionName = ref("");
const working = ref(false);
const localError = ref<string | null>(null);

const providerOptions = computed(() =>
  providers.value.map((provider) => ({
    value: provider.id,
    label: provider.label,
  })),
);
const selectedProvider = computed(
  () =>
    providers.value.find((provider) => provider.id === providerValue.value) ??
    null,
);

/** Builds provider-specific metadata for the collapsed preview details. */
const previewMetadata = computed<
  readonly { readonly label: string; readonly value: string }[]
>(() => {
  const currentPlan = plan.value;
  if (currentPlan === null) return [];
  const providerLabel =
    providers.value.find((provider) => provider.id === currentPlan.providerId)
      ?.label ?? currentPlan.providerId;
  const common = [
    { label: t("import.metadata.title"), value: currentPlan.suggestedName },
    { label: t("import.metadata.format"), value: providerLabel },
    { label: t("import.metadata.source"), value: currentPlan.sourceName },
  ];
  if (currentPlan.providerId === "openapi-json") {
    return [
      ...common,
      ...(currentPlan.pathPrefix === ""
        ? []
        : [
            {
              label: t("import.metadata.serverUrl"),
              value: currentPlan.pathPrefix,
            },
          ]),
    ];
  }
  return [
    ...common,
    {
      label: t("import.metadata.capturedResponses"),
      value: String(
        currentPlan.requests.filter(
          (request) => request.capturedExchange !== undefined,
        ).length,
      ),
    },
  ];
});
const sourceAccept = computed(() =>
  selectedProvider.value?.acceptedExtensions.join(","),
);
const sourcePrompt = computed(() =>
  selectedProvider.value === null
    ? t("import.chooseFile")
    : t("import.chooseFormatFile", { format: selectedProvider.value.label }),
);
const selectedCount = computed(() => selectedItemIds.value.length);
const destinationOptions = computed(() => [
  {
    value: "temporary",
    label: t("import.temporaryRequest"),
    disabled: selectedCount.value !== 1,
  },
  { value: "workspace", label: t("import.workspaceCollection") },
  ...(props.selectedCollectionId === null
    ? []
    : [
        {
          value: "collection",
          label: t("import.childCollection", {
            name: props.selectedCollectionName ?? t("collection.label"),
          }),
        },
      ]),
]);
const canPreview = computed(
  () =>
    selectedProvider.value !== null &&
    sourceName.value !== "" &&
    sourceText.value !== "" &&
    !working.value,
);
const blockingError = computed(() =>
  plan.value?.diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      (diagnostic.itemId !== undefined
        ? selectedItemIds.value.includes(diagnostic.itemId)
        : diagnostic.itemIds !== undefined
          ? diagnostic.itemIds.some((itemId) =>
              selectedItemIds.value.includes(itemId),
            )
          : true),
  ),
);
/** Collapses repeated provider messages and presents the most severe copy first. */
const presentedDiagnostics = computed(() => {
  const seenMessages = new Set<string>();
  return DIAGNOSTIC_SEVERITY_ORDER.flatMap((severity) =>
    (plan.value?.diagnostics ?? []).filter((diagnostic) => {
      if (diagnostic.severity !== severity) return false;
      const messageKey = diagnostic.message.trim();
      if (seenMessages.has(messageKey)) return false;
      seenMessages.add(messageKey);
      return true;
    }),
  );
});
const canImport = computed(
  () =>
    plan.value !== null &&
    selectedCount.value > 0 &&
    !blockingError.value &&
    !working.value &&
    !props.busy &&
    (destination.value !== "temporary" || selectedCount.value === 1) &&
    (destination.value !== "collection" ||
      props.selectedCollectionId !== null) &&
    (destination.value === "temporary" || collectionName.value.trim() !== ""),
);

watch(selectedCount, (count) => {
  if (count !== 1 && destination.value === "temporary") {
    destination.value = "workspace";
  }
});

watch(providerValue, () => {
  destination.value = "workspace";
  collectionName.value = "";
  sourceName.value = "";
  sourceText.value = "";
  plan.value = null;
  selectedItemIds.value = [];
  localError.value = null;
  if (sourceInput.value !== null) sourceInput.value.value = "";
});

onMounted(async () => {
  working.value = true;
  try {
    const availableProviders = (await props.listProviders()).providers;
    providers.value = availableProviders;
  } catch (cause) {
    localError.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
});

/** Requests closure through the shared controlled dialog lifecycle. */
function close(): void {
  open.value = false;
}

/** Reads one user-selected JSON source without retaining the browser File. */
async function selectSource(event: Event): Promise<void> {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  if (file === undefined) return;
  working.value = true;
  localError.value = null;
  plan.value = null;
  try {
    if (file.size > MAX_IMPORT_SOURCE_BYTES) {
      throw new Error(t("import.sourceTooLarge"));
    }
    sourceName.value = file.name;
    sourceText.value = await file.text();
  } catch (cause) {
    sourceName.value = "";
    sourceText.value = "";
    localError.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
}

/** Parses the current source and selects every request in the returned preview. */
async function preview(): Promise<void> {
  const provider = selectedProvider.value;
  if (!canPreview.value || provider === null) return;
  working.value = true;
  localError.value = null;
  try {
    const nextPlan = await props.previewImport(
      provider.id,
      sourceName.value,
      sourceText.value,
    );
    plan.value = nextPlan;
    selectedItemIds.value = nextPlan.requests.map((request) => request.itemId);
    destination.value =
      nextPlan.requests.length === 1 ? "temporary" : "workspace";
    collectionName.value = nextPlan.suggestedName;
  } catch (cause) {
    plan.value = null;
    selectedItemIds.value = [];
    localError.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
}

/** Toggles one preview request without changing provider diagnostics. */
function toggleRequest(itemId: string, checked: boolean): void {
  selectedItemIds.value = checked
    ? [...new Set([...selectedItemIds.value, itemId])]
    : selectedItemIds.value.filter((candidate) => candidate !== itemId);
}

/** Applies the selection to a temporary tab or one atomic saved collection. */
async function apply(): Promise<void> {
  const currentPlan = plan.value;
  if (!canImport.value || currentPlan === null) return;
  working.value = true;
  localError.value = null;
  try {
    if (destination.value === "temporary") {
      const selected = currentPlan.requests.find((request) =>
        selectedItemIds.value.includes(request.itemId),
      );
      if (selected !== undefined) props.openTemporary(currentPlan, selected);
    } else {
      await props.applyImport({
        providerId: currentPlan.providerId,
        sourceName: sourceName.value,
        sourceText: sourceText.value,
        plan: currentPlan,
        selectedItemIds: selectedItemIds.value,
        collectionName: collectionName.value.trim(),
        parentCollectionId:
          destination.value === "collection"
            ? props.selectedCollectionId
            : null,
      });
    }
    close();
  } catch (cause) {
    localError.value = errorMessage(cause);
  } finally {
    working.value = false;
  }
}

/** Produces a compact fallback for errors not represented by global state. */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("import.failed");
}
</script>

<template>
  <DialogControl
    v-model:open="open"
    class="resource-dialog import-dialog"
    :busy="working || busy"
    aria-labelledby="import-dialog-title"
    @close="emit('close')"
  >
    <div class="import-dialog-surface">
      <header class="resource-dialog-header">
        <div>
          <h2 id="import-dialog-title">{{ t("import.title") }}</h2>
        </div>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="working || busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>

      <div class="import-dialog-content">
        <div class="import-source-row">
          <FormField v-slot="{ controlId }" :label="t('import.format')">
            <SelectMenu
              v-model="providerValue"
              :options="providerOptions"
              :label="t('import.format')"
              :input-id="controlId"
              :placeholder="t('import.selectType')"
              :disabled="working || busy || providers.length === 0"
            />
          </FormField>
          <FormField
            v-slot="{ controlId, describedBy }"
            :label="t('import.source')"
          >
            <div
              class="import-file-picker"
              :data-disabled="
                working || busy || selectedProvider === null ? '' : undefined
              "
            >
              <label :for="controlId" class="import-file-button">
                <FileUp :size="17" aria-hidden="true" />
                <span
                  class="import-file-button-label"
                  :class="{ 'import-file-name': sourceName !== '' }"
                >
                  {{ sourceName || sourcePrompt }}
                </span>
              </label>
              <input
                :id="controlId"
                ref="sourceInput"
                class="import-file-input"
                type="file"
                :accept="sourceAccept"
                :aria-describedby="describedBy"
                :disabled="working || busy || selectedProvider === null"
                @change="selectSource"
              />
            </div>
          </FormField>
          <ButtonControl
            variant="secondary"
            :disabled="!canPreview || busy"
            @click="preview"
          >
            {{ t("import.preview") }}
          </ButtonControl>
        </div>

        <p v-if="localError" class="import-local-error" role="alert">
          {{ localError }}
        </p>

        <div v-if="plan" class="import-preview-region">
          <details
            :key="plan.sourceFingerprint"
            class="import-preview-metadata"
          >
            <summary>
              <ChevronRight
                class="import-preview-metadata-chevron"
                :size="16"
                aria-hidden="true"
              />
              <span>{{ t("import.metadata.heading") }}</span>
            </summary>
            <dl>
              <div v-for="entry in previewMetadata" :key="entry.label">
                <dt>{{ entry.label }}</dt>
                <dd>{{ entry.value }}</dd>
              </div>
            </dl>
          </details>

          <div class="import-preview-body">
            <fieldset class="import-request-list">
              <legend>{{ t("import.requests") }}</legend>
              <div class="import-request-items">
                <label
                  v-for="request in plan.requests"
                  :key="request.itemId"
                  class="import-request-item"
                >
                  <input
                    type="checkbox"
                    :checked="selectedItemIds.includes(request.itemId)"
                    :disabled="working || busy"
                    @change="
                      toggleRequest(
                        request.itemId,
                        ($event.currentTarget as HTMLInputElement).checked,
                      )
                    "
                  />
                  <strong>{{ request.method }}</strong>
                  <span class="import-request-name">{{ request.name }}</span>
                  <small
                    v-if="request.capturedExchange"
                    class="import-capture-label"
                  >
                    {{ t("import.capturedResponse") }}
                  </small>
                </label>
              </div>
            </fieldset>

            <fieldset
              v-if="presentedDiagnostics.length > 0"
              class="import-diagnostics"
            >
              <legend>{{ t("import.diagnostics") }}</legend>
              <ul>
                <li
                  v-for="diagnostic in presentedDiagnostics"
                  :key="diagnostic.message.trim()"
                  :data-severity="diagnostic.severity"
                >
                  <CircleAlert
                    v-if="diagnostic.severity === 'error'"
                    class="import-diagnostic-icon"
                    :size="18"
                    aria-hidden="true"
                  />
                  <TriangleAlert
                    v-else-if="diagnostic.severity === 'warning'"
                    class="import-diagnostic-icon"
                    :size="18"
                    aria-hidden="true"
                  />
                  <Info
                    v-else
                    class="import-diagnostic-icon"
                    :size="18"
                    aria-hidden="true"
                  />
                  <div class="import-diagnostic-content">
                    <strong>{{
                      t(`import.severity.${diagnostic.severity}`)
                    }}</strong>
                    <p>{{ diagnostic.message }}</p>
                  </div>
                </li>
              </ul>
            </fieldset>
          </div>

          <div class="import-destination">
            <FormField v-slot="{ controlId }" :label="t('import.destination')">
              <SelectMenu
                v-model="destination"
                :options="destinationOptions"
                :label="t('import.destination')"
                :input-id="controlId"
                :disabled="working || busy"
              />
            </FormField>
            <FormField
              v-if="destination !== 'temporary'"
              v-slot="{ controlId, describedBy, invalid }"
              :label="t('import.collectionName')"
            >
              <TextInput
                :id="controlId"
                v-model="collectionName"
                :aria-describedby="describedBy"
                :invalid="invalid"
                maxlength="200"
                autocomplete="off"
                :disabled="working || busy"
              />
            </FormField>
          </div>
        </div>
      </div>

      <footer class="resource-dialog-actions import-dialog-actions">
        <span v-if="plan" class="import-selected-count">{{
          t("import.selectedOfTotal", {
            selected: selectedCount,
            total: plan.requests.length,
          })
        }}</span>
        <ButtonControl
          variant="secondary"
          :disabled="working || busy"
          @click="close"
        >
          {{ t("common.actions.cancel") }}
        </ButtonControl>
        <ButtonControl variant="primary" :disabled="!canImport" @click="apply">
          {{ t("import.action") }}
        </ButtonControl>
      </footer>
    </div>
  </DialogControl>
</template>
