<script setup lang="ts">
import { computed, inject } from "vue";

import { tabsContextKey } from "./tabs-context";

/** Renders one native tab trigger linked to its corresponding panel. */
const props = withDefaults(
  defineProps<{
    value: string;
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

defineSlots<{
  default(props: { selected: boolean }): unknown;
}>();

const context = inject(tabsContextKey);
if (context === undefined) {
  throw new Error("TabsTrigger must be rendered inside TabsRoot.");
}

const selected = computed(() => context.selectedValue.value === props.value);
const triggerId = computed(() => `${context.baseId}-trigger-${props.value}`);
const panelId = computed(() => `${context.baseId}-panel-${props.value}`);
</script>

<template>
  <button
    :id="triggerId"
    class="tabs-trigger"
    type="button"
    role="tab"
    :disabled="disabled"
    :tabindex="selected ? 0 : -1"
    :aria-selected="selected"
    :aria-controls="panelId"
    :data-state="selected ? 'active' : 'inactive'"
    @click="context.select(value)"
  >
    <slot :selected="selected" />
  </button>
</template>
