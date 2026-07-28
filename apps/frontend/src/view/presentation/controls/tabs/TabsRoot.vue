<script setup lang="ts">
import { computed, provide, useId } from "vue";

import { tabsContextKey } from "./tabs-context";

/** Owns controlled selection and stable relationships for one tabs widget. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    activationMode?: "automatic" | "manual";
    orientation?: "horizontal" | "vertical";
  }>(),
  {
    activationMode: "automatic",
    orientation: "horizontal",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

defineSlots<{
  default(): unknown;
}>();

const selectedValue = computed(() => props.modelValue);
const baseId = `tabs-${useId()}`;

/** Requests a controlled tab selection change. */
function select(value: string): void {
  emit("update:modelValue", value);
}

provide(tabsContextKey, {
  selectedValue,
  activationMode: props.activationMode,
  orientation: props.orientation,
  baseId,
  select,
});
</script>

<template>
  <div
    class="tabs-root"
    :data-orientation="orientation"
    :data-value="modelValue"
  >
    <slot />
  </div>
</template>
