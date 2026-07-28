<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

/**
 * Owns the native modal lifecycle, dismissal policy, and close notification so
 * feature dialogs do not duplicate focus-sensitive overlay behavior.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    busy?: boolean;
  }>(),
  {
    closeOnBackdrop: true,
    closeOnEscape: true,
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

const dialog = ref<HTMLDialogElement | null>(null);

onMounted(() => synchronizeOpenState(props.open));

watch(
  () => props.open,
  (open) => synchronizeOpenState(open),
);

/** Synchronizes the controlled Vue state with the native top-layer dialog. */
function synchronizeOpenState(open: boolean): void {
  const element = dialog.value;
  if (element === null) {
    return;
  }
  if (open && !element.open) {
    element.showModal();
  } else if (!open && element.open) {
    element.close();
  }
}

/** Requests closure through the native dialog lifecycle. */
function close(): void {
  if (!props.busy) {
    dialog.value?.close();
  }
}

/** Emits the final controlled-state transition after native closure. */
function handleClose(): void {
  emit("update:open", false);
  emit("close");
}

/** Applies the explicit Escape policy to the native cancel event. */
function handleCancel(event: Event): void {
  if (props.busy || !props.closeOnEscape) {
    event.preventDefault();
  }
}

/** Closes only when pointer activation targets the native backdrop surface. */
function closeFromBackdrop(event: MouseEvent): void {
  if (props.closeOnBackdrop && !props.busy && event.target === dialog.value) {
    close();
  }
}

defineExpose({ close });
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog-control"
    :data-state="open ? 'open' : 'closed'"
    :data-busy="busy ? '' : undefined"
    @cancel="handleCancel"
    @click="closeFromBackdrop"
    @close="handleClose"
  >
    <slot />
  </dialog>
</template>
