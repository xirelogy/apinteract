<script setup lang="ts">
import { computed, inject } from "vue";

import { tabsContextKey } from "./tabs-context";

/** Renders one tab panel with stable ownership and labelling relationships. */
const props = defineProps<{
  value: string;
}>();

defineSlots<{
  default(): unknown;
}>();

const context = inject(tabsContextKey);
if (context === undefined) {
  throw new Error("TabsPanel must be rendered inside TabsRoot.");
}

const selected = computed(() => context.selectedValue.value === props.value);
const triggerId = computed(() => `${context.baseId}-trigger-${props.value}`);
const panelId = computed(() => `${context.baseId}-panel-${props.value}`);
</script>

<template>
  <div
    :id="panelId"
    class="tabs-panel"
    role="tabpanel"
    :tabindex="0"
    :aria-labelledby="triggerId"
    :data-state="selected ? 'active' : 'inactive'"
    :hidden="!selected"
  >
    <slot />
  </div>
</template>
