<script setup lang="ts">
import { computed, ref, watchEffect, type PropType } from "vue";

export type CheckboxState = boolean | "indeterminate";

/**
 * Keeps a native checkbox as the semantic and form owner while exposing a
 * fully stylable indicator and explicit tri-state presentation contract.
 */
const props = defineProps({
  modelValue: {
    type: [Boolean, String] as PropType<CheckboxState>,
    required: true,
  },
  label: { type: String, required: true },
  id: { type: String, default: undefined },
  name: { type: String, default: undefined },
  value: { type: String, default: "on" },
  disabled: { type: Boolean, default: false },
  required: { type: Boolean, default: false },
  invalid: { type: Boolean, default: false },
  visuallyHiddenLabel: { type: Boolean, default: false },
});

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  change: [value: boolean];
}>();

defineSlots<{
  indicator?(props: { checked: boolean; indeterminate: boolean }): unknown;
  label?(): unknown;
}>();

const input = ref<HTMLInputElement | null>(null);
const checked = computed(() => props.modelValue === true);
const indeterminate = computed(() => props.modelValue === "indeterminate");
const state = computed(() =>
  indeterminate.value
    ? "indeterminate"
    : checked.value
      ? "checked"
      : "unchecked",
);

watchEffect(
  () => {
    if (input.value !== null) {
      input.value.indeterminate = indeterminate.value;
    }
  },
  { flush: "post" },
);

/** Emits the native checkbox result after the browser resolves tri-state input. */
function updateValue(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  emit("update:modelValue", target.checked);
  emit("change", target.checked);
}
</script>

<template>
  <label
    class="checkbox-control"
    :data-state="state"
    :data-disabled="disabled ? '' : undefined"
    :data-invalid="invalid ? '' : undefined"
  >
    <input
      :id="id"
      ref="input"
      class="checkbox-control-input visually-hidden"
      type="checkbox"
      :name="name"
      :value="value"
      :checked="checked"
      :disabled="disabled"
      :required="required"
      :aria-invalid="invalid ? 'true' : undefined"
      @change="updateValue"
    />
    <span class="checkbox-control-indicator" aria-hidden="true">
      <slot name="indicator" :checked="checked" :indeterminate="indeterminate">
        <span class="checkbox-control-default-mark"></span>
      </slot>
    </span>
    <span
      class="checkbox-control-label"
      :class="{ 'visually-hidden': visuallyHiddenLabel }"
    >
      <slot name="label">{{ label }}</slot>
    </span>
  </label>
</template>
