<script setup lang="ts">
import DialogControl from "./DialogControl.vue";

/**
 * Applies the non-accidental dismissal policy expected for destructive or
 * consequential confirmation dialogs.
 */
withDefaults(
  defineProps<{
    open: boolean;
    busy?: boolean;
  }>(),
  {
    busy: false,
  },
);

const emit = defineEmits<{
  "update:open": [open: boolean];
  close: [];
}>();

defineSlots<{
  default(): unknown;
}>();
</script>

<template>
  <DialogControl
    :open="open"
    :busy="busy"
    :close-on-backdrop="false"
    @update:open="emit('update:open', $event)"
    @close="emit('close')"
  >
    <slot />
  </DialogControl>
</template>
