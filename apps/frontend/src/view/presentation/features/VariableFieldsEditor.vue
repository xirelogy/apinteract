<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, Trash2 } from "@lucide/vue";
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
const { t } = useI18n();
const variables = ref<DraftVariable[]>(
  props.profileVariables.map((variable) => ({
    variableId: variable.variableId,
    name: variable.name,
    kind: variable.kind,
    value: variable.kind === "value" ? variable.value : "",
    target: variable.kind === "alias" ? variable.target : "",
    hasValue: variable.kind === "secret" && variable.hasValue,
    secretTouched: false,
    clearValue: false,
  })),
);
const kindOptions = computed(() => [
  { value: "value", label: t("environment.kind.value") },
  { value: "secret", label: t("environment.kind.secret") },
  { value: "alias", label: t("environment.kind.alias") },
  { value: "unset", label: t("environment.kind.unset") },
]);

/** Adds one ordinary variable at the end of the scope's presentation order. */
function addVariable(): void {
  variables.value.push({
    name: "",
    kind: "value",
    value: "",
    target: "",
    hasValue: false,
    secretTouched: false,
    clearValue: false,
  });
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
}

/** Marks a secret field as an intentional replacement, including empty text. */
function updateSecret(variable: DraftVariable, value: string): void {
  variable.value = value;
  variable.secretTouched = true;
  variable.clearValue = false;
}

/** Reports whether the redacted stored-value state remains authoritative. */
function showStoredSecret(variable: DraftVariable): boolean {
  return variable.hasValue && !variable.secretTouched && !variable.clearValue;
}

/** Converts editor-local rows to write-only variable command values. */
function writes(): VariableWrite[] {
  return variables.value.map((variable) => {
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
    <div class="environment-variable-heading">
      <h3>{{ t("environment.variables") }}</h3>
      <ButtonControl
        v-if="canEdit"
        type="button"
        variant="secondary"
        size="compact"
        :disabled="busy"
        @click="addVariable"
      >
        <Plus :size="15" aria-hidden="true" />
        {{ t("environment.addVariable") }}
      </ButtonControl>
    </div>
    <div v-if="variables.length === 0" class="empty-state">
      {{ t("variables.noVariables") }}
    </div>
    <div
      v-for="(variable, index) in variables"
      :key="variable.variableId ?? index"
      class="environment-variable-row"
    >
      <TextInput
        v-model="variable.name"
        :disabled="busy || !canEdit"
        :aria-label="t('environment.variableName', { index: index + 1 })"
      />
      <SelectMenu
        :model-value="variable.kind"
        :options="kindOptions"
        :label="t('environment.variableKind', { index: index + 1 })"
        density="compact"
        :disabled="busy || !canEdit || variable.variableId !== undefined"
        @update:model-value="changeKind(variable, $event)"
      />
      <TextInput
        v-if="variable.kind === 'value'"
        v-model="variable.value"
        :disabled="busy || !canEdit"
        :aria-label="t('environment.variableValue', { index: index + 1 })"
      />
      <TextInput
        v-else-if="variable.kind === 'alias'"
        v-model="variable.target"
        :disabled="busy || !canEdit"
        :aria-label="t('environment.aliasTarget', { index: index + 1 })"
      />
      <div v-else-if="variable.kind === 'secret'" class="secret-editor">
        <span v-if="showStoredSecret(variable)">
          {{ t("environment.valueStored") }}
        </span>
        <TextInput
          :model-value="variable.value"
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
        class="environment-variable-empty-value"
        aria-hidden="true"
      ></span>
      <IconButton
        v-if="canEdit"
        :label="t('environment.removeVariable', { index: index + 1 })"
        :disabled="busy"
        @click="variables.splice(index, 1)"
      >
        <Trash2 :size="16" aria-hidden="true" />
      </IconButton>
    </div>
  </div>
</template>
