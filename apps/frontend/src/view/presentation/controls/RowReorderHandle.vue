<script setup lang="ts">
import { GripVertical } from "@lucide/vue";

import IconButton from "./IconButton.vue";

defineProps<{
  label: string;
  disabled: boolean;
}>();

const emit = defineEmits<{
  dragStart: [event: DragEvent];
  dragEnd: [];
  move: [offset: -1 | 1];
}>();

/** Applies the keyboard equivalent of moving the associated row. */
function handleKeydown(event: KeyboardEvent): void {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
    return;
  }
  event.preventDefault();
  emit("move", event.key === "ArrowUp" ? -1 : 1);
}
</script>

<template>
  <IconButton
    class="row-reorder-handle"
    size="compact"
    :label="label"
    :disabled="disabled"
    :draggable="!disabled"
    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
    @keydown="handleKeydown"
    @dragstart="emit('dragStart', $event)"
    @dragend="emit('dragEnd')"
  >
    <GripVertical :size="15" aria-hidden="true" />
  </IconButton>
</template>
