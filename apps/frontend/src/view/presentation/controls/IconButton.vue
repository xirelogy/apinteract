<script setup lang="ts">
import ButtonControl from "./ButtonControl.vue";

/**
 * Renders an icon-only native button whose accessible name is required by its
 * public contract rather than repeated at each call site.
 */
defineProps({
  label: { type: String, required: true },
  title: { type: String, default: undefined },
  size: {
    type: String as () => "compact" | "default",
    default: "default",
  },
  type: {
    type: String as () => "button" | "submit" | "reset",
    default: "button",
  },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

defineSlots<{
  default(): unknown;
}>();
</script>

<template>
  <ButtonControl
    class="icon-button-control"
    variant="ghost"
    :size="size"
    :type="type"
    :disabled="disabled"
    :busy="busy"
    :aria-label="label"
    :title="title ?? label"
  >
    <slot />
  </ButtonControl>
</template>
