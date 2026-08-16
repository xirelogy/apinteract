<script setup lang="ts">
import CodeEditor from "./CodeEditor.vue";

/** Preserves the request-script control API while using the shared code editor. */
withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  input: [];
}>();
</script>

<template>
  <CodeEditor
    class="script-editor-control"
    language="javascript"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
    @input="emit('input')"
  />
</template>
