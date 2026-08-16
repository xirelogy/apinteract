<script setup lang="ts">
import { computed } from "vue";
import { FileText, Paperclip } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "./IconButton.vue";

export type FormValueType = "text" | "file";

const props = withDefaults(
  defineProps<{
    modelValue: FormValueType;
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{
  "update:modelValue": [valueType: FormValueType];
  change: [valueType: FormValueType];
}>();
const { t } = useI18n();
const valueTypeLabel = computed(() =>
  t(`request.formValueTypes.${props.modelValue}`),
);

/** Switches the row between a text value and an uploaded file value. */
function toggle(): void {
  if (props.disabled) return;
  const valueType = props.modelValue === "text" ? "file" : "text";
  emit("update:modelValue", valueType);
  emit("change", valueType);
}
</script>

<template>
  <IconButton
    class="form-value-type-toggle"
    :data-type="modelValue"
    size="compact"
    :label="t('request.formValueTypes.change', { type: valueTypeLabel })"
    :title="valueTypeLabel"
    :disabled="disabled"
    @click="toggle"
  >
    <Paperclip v-if="modelValue === 'file'" :size="15" aria-hidden="true" />
    <FileText v-else :size="15" aria-hidden="true" />
  </IconButton>
</template>
