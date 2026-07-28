<script setup lang="ts">
/** Provides a typed native text-input contract with shared state styling. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    density?: "compact" | "default";
    font?: "mono" | "sans";
    invalid?: boolean;
  }>(),
  {
    density: "default",
    font: "sans",
    invalid: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [event: Event];
  change: [event: Event];
}>();

/** Emits the current native input value and preserves the original input event. */
function updateValue(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  emit("update:modelValue", target.value);
  emit("input", event);
}
</script>

<template>
  <input
    class="text-input-control"
    :class="[`text-input-control-${density}`, `text-input-control-${font}`]"
    :value="props.modelValue"
    :aria-invalid="invalid ? 'true' : undefined"
    :data-invalid="invalid ? '' : undefined"
    @input="updateValue"
    @change="emit('change', $event)"
  />
</template>
