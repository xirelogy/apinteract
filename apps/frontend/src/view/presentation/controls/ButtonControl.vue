<script setup lang="ts">
/**
 * Renders the shared native action control while keeping visual variants and
 * busy-state behavior consistent across presentation features.
 */
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "danger" | "danger-outline" | "ghost";
    size?: "compact" | "default";
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    busy?: boolean;
  }>(),
  {
    variant: "secondary",
    size: "default",
    type: "button",
    disabled: false,
    busy: false,
  },
);

defineSlots<{
  leading?(): unknown;
  default(): unknown;
  trailing?(): unknown;
}>();
</script>

<template>
  <button
    class="button-control"
    :class="[`${variant}-button`, { 'compact-button': size === 'compact' }]"
    :type="type"
    :disabled="disabled || busy"
    :aria-busy="busy ? 'true' : undefined"
    :data-busy="busy ? '' : undefined"
    :data-disabled="disabled || busy ? '' : undefined"
  >
    <span v-if="$slots.leading" class="button-control-leading">
      <slot name="leading" />
    </span>
    <span class="button-control-label"><slot /></span>
    <span v-if="$slots.trailing" class="button-control-trailing">
      <slot name="trailing" />
    </span>
  </button>
</template>
