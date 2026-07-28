<script setup lang="ts">
import { computed, useId } from "vue";

/**
 * Owns accessible label, hint, and error relationships while allowing the
 * caller to choose the appropriate native or composite input control.
 */
const props = defineProps({
  label: { type: String, required: true },
  controlId: { type: String, default: undefined },
  hint: { type: String, default: undefined },
  error: { type: String, default: undefined },
  visuallyHiddenLabel: { type: Boolean, default: false },
});

defineSlots<{
  default(props: {
    controlId: string;
    describedBy: string | undefined;
    invalid: boolean;
  }): unknown;
  label?(): unknown;
  hint?(): unknown;
  error?(): unknown;
}>();

const generatedId = useId();
const resolvedControlId = computed(
  () => props.controlId ?? `form-control-${generatedId}`,
);
const hintId = computed(() => `form-hint-${generatedId}`);
const errorId = computed(() => `form-error-${generatedId}`);
const describedBy = computed(() => {
  const ids: string[] = [];
  if (props.hint !== undefined) {
    ids.push(hintId.value);
  }
  if (props.error !== undefined) {
    ids.push(errorId.value);
  }
  return ids.length === 0 ? undefined : ids.join(" ");
});
</script>

<template>
  <div class="form-field" :data-invalid="error !== undefined ? '' : undefined">
    <label
      class="form-field-label"
      :class="{ 'visually-hidden': visuallyHiddenLabel }"
      :for="resolvedControlId"
    >
      <slot name="label">{{ label }}</slot>
    </label>
    <slot
      :control-id="resolvedControlId"
      :described-by="describedBy"
      :invalid="error !== undefined"
    />
    <p v-if="hint !== undefined" :id="hintId" class="form-field-hint">
      <slot name="hint">{{ hint }}</slot>
    </p>
    <p
      v-if="error !== undefined"
      :id="errorId"
      class="form-field-error"
      role="alert"
    >
      <slot name="error">{{ error }}</slot>
    </p>
  </div>
</template>
