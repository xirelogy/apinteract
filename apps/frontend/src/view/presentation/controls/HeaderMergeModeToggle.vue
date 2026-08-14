<script setup lang="ts">
import { computed } from "vue";
import { ListPlus, Replace } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { HeaderMergeMode } from "@/app/preferences/header-preferences";
import IconButton from "./IconButton.vue";

const props = withDefaults(
  defineProps<{
    modelValue: HeaderMergeMode;
    disabled?: boolean;
    readonly?: boolean;
  }>(),
  { disabled: false, readonly: false },
);
const emit = defineEmits<{
  "update:modelValue": [mode: HeaderMergeMode];
  change: [mode: HeaderMergeMode];
}>();
const { t } = useI18n();
const modeLabel = computed(() => t(`request.headerMode.${props.modelValue}`));

/** Switches between replacing ancestor values and retaining them. */
function toggle(): void {
  if (props.disabled || props.readonly) return;
  const mode = props.modelValue === "override" ? "append" : "override";
  emit("update:modelValue", mode);
  emit("change", mode);
}
</script>

<template>
  <span
    v-if="readonly"
    class="header-merge-mode-indicator"
    :data-mode="modelValue"
    role="img"
    :aria-label="modeLabel"
    :title="modeLabel"
  >
    <ListPlus v-if="modelValue === 'append'" :size="15" aria-hidden="true" />
    <Replace v-else :size="15" aria-hidden="true" />
  </span>
  <IconButton
    v-else
    class="header-merge-mode-toggle"
    :data-mode="modelValue"
    size="compact"
    :label="t('request.headerMode.change', { mode: modeLabel })"
    :title="modeLabel"
    :disabled="disabled"
    @click="toggle"
  >
    <ListPlus v-if="modelValue === 'append'" :size="15" aria-hidden="true" />
    <Replace v-else :size="15" aria-hidden="true" />
  </IconButton>
</template>
