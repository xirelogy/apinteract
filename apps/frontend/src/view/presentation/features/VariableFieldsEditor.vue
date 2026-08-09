<script setup lang="ts">
import { computed, ref } from "vue";
import { Asterisk, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  VariableProfileView,
  VariableWrite,
} from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";

interface DraftVariable {
  readonly variableId?: string;
  name: string;
  kind: "value" | "secret" | "alias" | "unset";
  value: string;
  target: string;
  hasValue: boolean;
  secretTouched: boolean;
  clearValue: boolean;
}

const props = defineProps<{
  profileVariables: VariableProfileView["variables"];
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  countChange: [count: number];
}>();
const { t } = useI18n();
const variables = ref<DraftVariable[]>([
  ...props.profileVariables.map((variable) => ({
    variableId: variable.variableId,
    name: variable.name,
    kind: variable.kind,
    value: variable.kind === "value" ? variable.value : "",
    target: variable.kind === "alias" ? variable.target : "",
    hasValue: variable.kind === "secret" && variable.hasValue,
    secretTouched: false,
    clearValue: false,
  })),
  ...(props.canEdit ? [createBlankVariable()] : []),
]);
const kindOptions = computed(() => [
  { value: "value", label: t("environment.kind.value") },
  { value: "secret", label: t("environment.kind.secret") },
  { value: "alias", label: t("environment.kind.alias") },
  { value: "unset", label: t("environment.kind.unset") },
]);

/** Creates the presentation-only row used to begin a new variable. */
function createBlankVariable(): DraftVariable {
  return {
    name: "",
    kind: "value",
    value: "",
    target: "",
    hasValue: false,
    secretTouched: false,
    clearValue: false,
  };
}

/** Reports whether a variable row contains no user-authored profile content. */
function isBlankVariable(variable: DraftVariable): boolean {
  return (
    variable.variableId === undefined &&
    variable.name === "" &&
    variable.kind === "value" &&
    variable.value === "" &&
    variable.target === "" &&
    !variable.secretTouched &&
    !variable.clearValue
  );
}

/** Appends the next blank row after the current trailing row becomes meaningful. */
function ensureTrailingBlankVariable(): void {
  const last = variables.value[variables.value.length - 1];
  if (props.canEdit && (last === undefined || !isBlankVariable(last))) {
    variables.value.push(createBlankVariable());
  }
}

/** Publishes the profile count without including presentation-only blank rows. */
function publishCount(): void {
  emit(
    "countChange",
    variables.value.filter((variable) => !isBlankVariable(variable)).length,
  );
}

/** Handles text edits and materializes the next trailing blank variable. */
function updateVariable(): void {
  ensureTrailingBlankVariable();
  publishCount();
}

/** Removes one variable and publishes the new editor-local row count. */
function removeVariable(index: number): void {
  variables.value.splice(index, 1);
  ensureTrailingBlankVariable();
  publishCount();
}

/** Changes kind only for a new variable because persisted kinds are immutable. */
function changeKind(variable: DraftVariable, kind: string): void {
  if (variable.variableId !== undefined) {
    return;
  }
  variable.kind = kind as DraftVariable["kind"];
  if (variable.kind === "secret") {
    variable.secretTouched = true;
  }
  updateVariable();
}

/** Marks a secret field as an intentional replacement, including empty text. */
function updateSecret(variable: DraftVariable, value: string): void {
  variable.value = value;
  variable.secretTouched = true;
  variable.clearValue = false;
  updateVariable();
}

/** Reports whether the redacted stored-value state remains authoritative. */
function showStoredSecret(variable: DraftVariable): boolean {
  return variable.hasValue && !variable.secretTouched && !variable.clearValue;
}

/** Converts editor-local rows to write-only variable command values. */
function writes(): VariableWrite[] {
  return variables.value
    .filter((variable) => !isBlankVariable(variable))
    .map((variable) => {
      const common = {
        ...(variable.variableId === undefined
          ? {}
          : { variableId: variable.variableId }),
        name: variable.name,
      };
      switch (variable.kind) {
        case "value":
          return { ...common, kind: "value", value: variable.value };
        case "alias":
          return { ...common, kind: "alias", target: variable.target };
        case "unset":
          return { ...common, kind: "unset" };
        case "secret":
          return {
            ...common,
            kind: "secret",
            ...(variable.secretTouched ? { value: variable.value } : {}),
            ...(variable.clearValue ? { clearValue: true } : {}),
          };
      }
    });
}

defineExpose({ writes });
</script>

<template>
  <div class="variable-fields-editor">
    <div class="variable-field-heading" aria-hidden="true">
      <span>{{ t("common.fields.name") }}</span>
      <span>{{ t("common.fields.type") }}</span>
      <span>{{ t("common.fields.valueOrTarget") }}</span>
      <span></span>
    </div>
    <div
      v-for="(variable, index) in variables"
      :key="variable.variableId ?? index"
      class="variable-field-row"
    >
      <TextInput
        v-model="variable.name"
        class="field-cell-input"
        density="compact"
        font="mono"
        :disabled="busy || !canEdit"
        :placeholder="
          isBlankVariable(variable)
            ? t('environment.addVariable')
            : t('common.fields.name')
        "
        :aria-label="t('environment.variableName', { index: index + 1 })"
        autocomplete="off"
        spellcheck="false"
        @input="updateVariable"
      />
      <div
        class="variable-type-cell"
        :title="
          variable.variableId === undefined
            ? undefined
            : t('variables.typeLocked')
        "
      >
        <SelectMenu
          :model-value="variable.kind"
          :options="kindOptions"
          :label="t('environment.variableKind', { index: index + 1 })"
          density="compact"
          :disabled="busy || !canEdit || variable.variableId !== undefined"
          @update:model-value="changeKind(variable, $event)"
        />
      </div>
      <TextInput
        v-if="variable.kind === 'value'"
        v-model="variable.value"
        class="field-cell-input"
        density="compact"
        font="mono"
        :disabled="busy || !canEdit"
        :placeholder="t('common.fields.value')"
        :aria-label="t('environment.variableValue', { index: index + 1 })"
        autocomplete="off"
        spellcheck="false"
        @input="updateVariable"
      />
      <TextInput
        v-else-if="variable.kind === 'alias'"
        v-model="variable.target"
        class="field-cell-input"
        density="compact"
        font="mono"
        :disabled="busy || !canEdit"
        :placeholder="t('common.fields.target')"
        :aria-label="t('environment.aliasTarget', { index: index + 1 })"
        autocomplete="off"
        spellcheck="false"
        @input="updateVariable"
      />
      <div v-else-if="variable.kind === 'secret'" class="secret-editor">
        <span v-if="showStoredSecret(variable)" class="secret-stored-status">
          {{ t("environment.valueStored") }}
        </span>
        <TextInput
          :model-value="variable.value"
          density="compact"
          font="mono"
          type="password"
          :disabled="busy || !canEdit"
          autocomplete="new-password"
          :placeholder="variable.hasValue ? t('environment.replaceSecret') : ''"
          :aria-label="t('environment.secretValue', { index: index + 1 })"
          @update:model-value="updateSecret(variable, $event)"
        />
        <ButtonControl
          v-if="variable.hasValue && canEdit"
          type="button"
          variant="ghost"
          size="compact"
          :disabled="busy"
          @click="
            variable.clearValue = true;
            variable.secretTouched = false;
            variable.value = '';
          "
        >
          {{ t("environment.clearSecret") }}
        </ButtonControl>
      </div>
      <span
        v-else
        class="variable-field-empty-value"
        :aria-label="t('environment.noValue')"
      >
        —
      </span>
      <IconButton
        v-if="canEdit && !isBlankVariable(variable)"
        class="compact-icon-button"
        size="compact"
        :label="t('environment.removeVariable', { index: index + 1 })"
        :title="t('environment.removeVariableTitle')"
        :disabled="busy"
        @click="removeVariable(index)"
      >
        <Trash2 :size="16" aria-hidden="true" />
      </IconButton>
      <span v-else class="new-row-marker" aria-hidden="true">
        <Asterisk :size="16" />
      </span>
    </div>
  </div>
</template>
