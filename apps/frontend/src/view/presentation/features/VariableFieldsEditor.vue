<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { Asterisk, CircleX, LockKeyhole, RotateCcw, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  VariableProfileView,
  VariableWrite,
} from "@/model/contracts/backend";
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

type SecretInputState = "empty" | "stored" | "replacement" | "pending-clear";

const props = defineProps<{
  profileVariables: VariableProfileView["variables"];
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  countChange: [count: number];
}>();
const { t } = useI18n();
const secretDescriptionIdPrefix = useId();
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
  updateVariable();
}

/** Marks non-empty secret text as a replacement and restores an empty stored secret. */
function updateSecret(variable: DraftVariable, value: string): void {
  variable.value = value;
  variable.secretTouched = value !== "";
  variable.clearValue = false;
  updateVariable();
}

/** Reports the visual and save-pending state of a secret field. */
function secretState(variable: DraftVariable): SecretInputState {
  if (variable.clearValue) {
    return "pending-clear";
  }
  if (variable.secretTouched && variable.value !== "") {
    return "replacement";
  }
  return variable.hasValue ? "stored" : "empty";
}

/** Returns input guidance appropriate to the current redacted secret state. */
function secretPlaceholder(variable: DraftVariable): string {
  switch (secretState(variable)) {
    case "stored":
      return t("environment.secretStoredPlaceholder");
    case "pending-clear":
      return t("environment.secretClearPendingPlaceholder");
    case "empty":
    case "replacement":
      return t("environment.enterSecretValue");
  }
}

/** Returns assistive text that states the secret lifecycle without relying on visuals. */
function secretDescription(variable: DraftVariable): string {
  return t(`environment.secretState.${secretState(variable)}`);
}

/** Creates a component-local description identifier for one secret row. */
function secretDescriptionId(index: number): string {
  return `${secretDescriptionIdPrefix}-secret-${index}`;
}

/** Marks the stored secret for removal when the profile is next saved. */
function clearSecret(variable: DraftVariable): void {
  variable.value = "";
  variable.secretTouched = false;
  variable.clearValue = true;
  updateVariable();
}

/** Discards an entered replacement and returns to the prior stored-value state. */
function discardSecretReplacement(variable: DraftVariable): void {
  variable.value = "";
  variable.secretTouched = false;
  variable.clearValue = false;
  updateVariable();
}

/** Cancels a pending clear while retaining the server-held secret. */
function restoreStoredSecret(variable: DraftVariable): void {
  variable.value = "";
  variable.secretTouched = false;
  variable.clearValue = false;
  updateVariable();
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
      <div
        v-else-if="variable.kind === 'secret'"
        class="secret-input-shell"
        :data-secret-state="secretState(variable)"
      >
        <LockKeyhole
          v-if="secretState(variable) === 'stored'"
          class="secret-input-lock"
          :size="15"
          aria-hidden="true"
        />
        <TextInput
          :model-value="variable.value"
          class="secret-input"
          density="compact"
          font="mono"
          type="password"
          :disabled="busy || !canEdit"
          autocomplete="new-password"
          :placeholder="secretPlaceholder(variable)"
          :aria-label="t('environment.secretValue', { index: index + 1 })"
          :aria-describedby="secretDescriptionId(index)"
          @update:model-value="updateSecret(variable, $event)"
        />
        <IconButton
          v-if="secretState(variable) === 'stored' && canEdit"
          class="secret-input-action"
          size="compact"
          :label="t('environment.clearStoredSecret')"
          :disabled="busy"
          @click="clearSecret(variable)"
        >
          <CircleX :size="16" aria-hidden="true" />
        </IconButton>
        <IconButton
          v-else-if="secretState(variable) === 'replacement' && canEdit"
          class="secret-input-action"
          size="compact"
          :label="t('environment.discardSecretReplacement')"
          :disabled="busy"
          @click="discardSecretReplacement(variable)"
        >
          <CircleX :size="16" aria-hidden="true" />
        </IconButton>
        <IconButton
          v-else-if="secretState(variable) === 'pending-clear' && canEdit"
          class="secret-input-action"
          size="compact"
          :label="t('environment.keepStoredSecret')"
          :disabled="busy"
          @click="restoreStoredSecret(variable)"
        >
          <RotateCcw :size="16" aria-hidden="true" />
        </IconButton>
        <span :id="secretDescriptionId(index)" class="visually-hidden">
          {{ secretDescription(variable) }}
        </span>
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
