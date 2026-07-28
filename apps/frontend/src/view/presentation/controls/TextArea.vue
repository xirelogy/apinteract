<script setup lang="ts">
/** Provides a typed native textarea contract with shared state styling. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    font?: "mono" | "sans";
    invalid?: boolean;
  }>(),
  {
    font: "sans",
    invalid: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [event: Event];
  change: [event: Event];
}>();

/** Emits the current native textarea value and preserves the input event. */
function updateValue(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLTextAreaElement)) {
    return;
  }
  emit("update:modelValue", target.value);
  emit("input", event);
}
</script>

<template>
  <textarea
    class="text-area-control"
    :class="`text-area-control-${font}`"
    :value="props.modelValue"
    :aria-invalid="invalid ? 'true' : undefined"
    :data-invalid="invalid ? '' : undefined"
    @input="updateValue"
    @change="emit('change', $event)"
  ></textarea>
</template>
