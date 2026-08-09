<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useAttrs,
  useId,
  watch,
} from "vue";
import { useI18n } from "vue-i18n";

import type { VariablePreview } from "@/model/contracts/backend";
import {
  parseTemplateSegments,
  type TemplateSegment,
} from "@/model/domain/template-variables";

type VariableScope = NonNullable<VariablePreview["source"]>["scope"];

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    previews: readonly VariablePreview[];
    multiline?: boolean;
    density?: "compact" | "default";
    font?: "mono" | "sans";
    invalid?: boolean;
    disabled?: boolean;
  }>(),
  {
    multiline: false,
    density: "default",
    font: "sans",
    invalid: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [event: Event];
  change: [event: Event];
}>();
const attrs = useAttrs();
const { t } = useI18n();
const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const mirrorContent = ref<HTMLElement | null>(null);
const tooltip = ref<HTMLElement | null>(null);
const tooltipStyle = ref<Record<string, string>>({ visibility: "hidden" });
const tooltipId = `variable-preview-${useId()}`;
const segments = computed(() => parseTemplateSegments(props.modelValue));
const previewByName = computed(
  () => new Map(props.previews.map((preview) => [preview.name, preview])),
);
const activeSegment = ref<Extract<
  TemplateSegment,
  { kind: "variable" }
> | null>(null);
const activePreview = computed(() =>
  activeSegment.value === null
    ? null
    : (previewByName.value.get(activeSegment.value.name) ?? null),
);
const showsOrdinaryValue = computed(
  () =>
    activePreview.value?.status === "resolved" &&
    activePreview.value.effectiveKind === "value",
);
const showsSecretMetadata = computed(
  () =>
    activePreview.value?.status === "resolved" &&
    activePreview.value.effectiveKind === "secret",
);
const ordinaryDisplayValue = computed(() =>
  activePreview.value?.value === ""
    ? t("environment.preview.emptyValue")
    : (activePreview.value?.value ?? ""),
);
const activeDiagnostic = computed(() =>
  activePreview.value === null
    ? null
    : localizedDiagnostic(activePreview.value),
);
const wrapperClass = computed(() =>
  typeof attrs.class === "string" ? attrs.class : undefined,
);
const controlAttributes = computed(() =>
  Object.fromEntries(
    Object.entries(attrs).filter(
      ([name]) => name !== "class" && name !== "style",
    ),
  ),
);
const describedBy = computed(() => {
  const external = attrs["aria-describedby"];
  return (
    [
      typeof external === "string" ? external : null,
      activeSegment.value === null ? null : tooltipId,
    ]
      .filter((value): value is string => value !== null && value !== "")
      .join(" ") || undefined
  );
});

watch(
  () => props.modelValue,
  () => void nextTick(synchronizeMirror),
);

watch([activeSegment, activePreview], ([segment]) => {
  if (segment === null) {
    stopTooltipPositionTracking();
    return;
  }
  startTooltipPositionTracking();
  tooltipStyle.value = { visibility: "hidden" };
  void nextTick(positionTooltip);
});

onBeforeUnmount(stopTooltipPositionTracking);

/** Emits native edits while retaining the underlying accessible form control. */
function updateValue(event: Event): void {
  const target = event.currentTarget;
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement)
  ) {
    return;
  }
  emit("update:modelValue", target.value);
  emit("input", event);
  void nextTick(() => {
    synchronizeMirror();
    updateInspection();
  });
}

/** Keeps decorated text aligned with native horizontal and vertical scrolling. */
function synchronizeMirror(): void {
  const element = control.value;
  const mirror = mirrorContent.value;
  if (element === null || mirror === null) {
    return;
  }
  mirror.style.transform = `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`;
}

/** Starts repositioning the viewport overlay when an ancestor or window moves. */
function startTooltipPositionTracking(): void {
  window.addEventListener("resize", positionTooltip);
  window.addEventListener("scroll", positionTooltip, true);
}

/** Stops viewport listeners when no inspection overlay is visible. */
function stopTooltipPositionTracking(): void {
  window.removeEventListener("resize", positionTooltip);
  window.removeEventListener("scroll", positionTooltip, true);
}

/** Positions the tooltip without contributing to an editor's scrollable overflow. */
function positionTooltip(): void {
  const anchor = control.value;
  const overlay = tooltip.value;
  if (anchor === null || overlay === null) {
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const gap = 4;
  const viewportPadding = 12;
  const roomBelow =
    window.innerHeight - anchorRect.bottom - gap - viewportPadding;
  const top =
    overlayRect.height <= roomBelow
      ? anchorRect.bottom + gap
      : Math.max(viewportPadding, anchorRect.top - gap - overlayRect.height);
  const maximumLeft = Math.max(
    viewportPadding,
    window.innerWidth - viewportPadding - overlayRect.width,
  );
  const left = Math.min(
    Math.max(viewportPadding, anchorRect.left),
    maximumLeft,
  );
  tooltipStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

/** Selects the placeholder containing the native caret for safe inspection. */
function updateInspection(): void {
  if (props.disabled) {
    activeSegment.value = null;
    return;
  }
  const position = control.value?.selectionStart ?? -1;
  activeSegment.value =
    segments.value.find(
      (segment): segment is Extract<TemplateSegment, { kind: "variable" }> =>
        segment.kind === "variable" &&
        position >= segment.start &&
        position <= segment.end,
    ) ?? null;
}

/** Clears transient inspection details when keyboard focus leaves the field. */
function clearInspection(): void {
  activeSegment.value = null;
}

/** Returns the authoritative or local parsing status for one placeholder. */
function tokenStatus(
  segment: Extract<TemplateSegment, { kind: "variable" }>,
): string {
  if (!segment.valid) {
    return "error";
  }
  return previewByName.value.get(segment.name)?.status ?? "pending";
}

/** Returns token classes that distinguish kind and resolution without color alone. */
function tokenClasses(
  segment: Extract<TemplateSegment, { kind: "variable" }>,
): string[] {
  const preview = previewByName.value.get(segment.name);
  return [
    "template-variable-token",
    `template-variable-token-${tokenStatus(segment)}`,
    ...(preview?.declaredKind === null || preview?.declaredKind === undefined
      ? []
      : [`template-variable-token-kind-${preview.declaredKind}`]),
    ...(preview?.effectiveKind === "secret"
      ? ["template-variable-token-secret-tainted"]
      : []),
  ];
}

/** Translates one declared variable kind for the inspection popover. */
function kindLabel(kind: VariablePreview["declaredKind"]): string {
  switch (kind) {
    case "value":
      return t("environment.kind.value");
    case "secret":
      return t("environment.kind.secret");
    case "alias":
      return t("environment.kind.alias");
    case "unset":
      return t("environment.kind.unset");
    case null:
      return t("environment.preview.unknownKind");
  }
}

/** Translates one effective persisted variable scope for inspection. */
function scopeLabel(scope: VariableScope): string {
  return t(`variables.scope.${scope}`);
}

/** Converts backend resolution state into locale-owned presentation text. */
function localizedDiagnostic(preview: VariablePreview): string | null {
  switch (preview.status) {
    case "resolved":
      return null;
    case "missing":
      return t("environment.preview.missingVariable", { name: preview.name });
    case "unset":
      return t("environment.preview.unsetVariable", { name: preview.name });
    case "error":
      return t("environment.preview.resolutionError", { name: preview.name });
  }
}
</script>

<template>
  <div
    class="template-text-control"
    :class="wrapperClass"
    :data-multiline="multiline ? '' : undefined"
    :data-density="density"
    :data-font="font"
    :data-disabled="disabled ? '' : undefined"
  >
    <div class="template-text-control-mirror" aria-hidden="true">
      <div ref="mirrorContent" class="template-text-control-mirror-content">
        <template v-for="(segment, index) in segments" :key="index">
          <span
            v-if="segment.kind === 'variable'"
            :class="tokenClasses(segment)"
            :data-preview-status="tokenStatus(segment)"
            :data-variable-name="segment.name"
            v-text="segment.text"
          ></span>
          <span v-else>{{ segment.text }}</span>
        </template>
      </div>
    </div>

    <textarea
      v-if="multiline"
      ref="control"
      v-bind="controlAttributes"
      class="text-area-control text-area-control-mono template-text-control-input"
      :value="modelValue"
      :disabled="disabled"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedBy"
      :data-invalid="invalid ? '' : undefined"
      @input="updateValue"
      @change="emit('change', $event)"
      @scroll="synchronizeMirror"
      @focus="updateInspection"
      @click="updateInspection"
      @keyup="updateInspection"
      @select="updateInspection"
      @blur="clearInspection"
    ></textarea>
    <input
      v-else
      ref="control"
      v-bind="controlAttributes"
      class="text-input-control template-text-control-input"
      :class="[`text-input-control-${density}`, `text-input-control-${font}`]"
      :value="modelValue"
      :disabled="disabled"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedBy"
      :data-invalid="invalid ? '' : undefined"
      @input="updateValue"
      @change="emit('change', $event)"
      @scroll="synchronizeMirror"
      @focus="updateInspection"
      @click="updateInspection"
      @keyup="updateInspection"
      @select="updateInspection"
      @blur="clearInspection"
    />

    <div
      v-if="activeSegment"
      :id="tooltipId"
      ref="tooltip"
      class="variable-preview-popover"
      role="tooltip"
      :style="tooltipStyle"
    >
      <strong><code v-text="activeSegment.text"></code></strong>
      <span v-if="!activeSegment.valid" class="variable-preview-error">
        {{ t("environment.preview.invalidPlaceholder") }}
      </span>
      <template v-else-if="activePreview">
        <span>
          {{ kindLabel(activePreview.declaredKind) }}
          <template v-if="activePreview.source">
            ·
            {{
              t("environment.preview.scopeSource", {
                scope: scopeLabel(activePreview.source.scope),
                name: activePreview.source.scopeName,
              })
            }}
          </template>
        </span>
        <span v-if="activePreview.aliasTarget">
          {{
            t("environment.preview.aliasTarget", {
              target: activePreview.aliasTarget,
            })
          }}
        </span>
        <code
          v-if="showsOrdinaryValue"
          class="variable-preview-value"
          v-text="ordinaryDisplayValue"
        ></code>
        <span v-else-if="showsSecretMetadata">
          {{
            t("environment.preview.secretStored", {
              version: activePreview.secretVersion ?? "–",
            })
          }}
        </span>
        <span
          v-if="activeDiagnostic"
          :class="{
            'variable-preview-error': activePreview.status !== 'resolved',
          }"
        >
          {{ activeDiagnostic }}
        </span>
      </template>
      <span v-else>{{ t("environment.preview.checking") }}</span>
    </div>
  </div>
</template>
