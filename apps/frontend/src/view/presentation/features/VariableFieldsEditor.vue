<script setup lang="ts">
import { computed, ref, useId } from "vue";
import {
  Asterisk,
  CircleX,
  Lock,
  LockKeyhole,
  FilePenLine,
  RotateCcw,
  Trash2,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  VariableProfileView,
  VariableWrite,
} from "@/model/contracts/backend";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import RowReorderHandle from "@/view/presentation/controls/RowReorderHandle.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import { useRowReorder } from "@/view/presentation/controls/row-reorder";

interface DraftVariable {
  readonly rowKey: symbol;
  readonly variableId?: string;
  name: string;
  kind: "value" | "secret" | "alias" | "unset";
  value: string;
  target: string;
  description: string;
  hasValue: boolean;
  secretTouched: boolean;
  clearValue: boolean;
}

type SecretInputState = "empty" | "stored" | "replacement" | "pending-clear";
type InheritedVariable = VariableProfileView["inheritedVariables"][number];

const props = withDefaults(
  defineProps<{
    profileVariables: VariableProfileView["variables"];
    // Absence intentionally falls back to the persisted profile variables.
    // eslint-disable-next-line vue/require-default-prop
    draftVariables?: readonly VariableWrite[] | undefined;
    inheritedVariables?: VariableProfileView["inheritedVariables"];
    canEdit: boolean;
    busy: boolean;
  }>(),
  { inheritedVariables: () => [] },
);
const emit = defineEmits<{
  countChange: [count: number];
  change: [variables: readonly VariableWrite[]];
}>();
const { t } = useI18n();
const secretDescriptionIdPrefix = useId();
const profileVariablesById = new Map(
  props.profileVariables.map((variable) => [variable.variableId, variable]),
);
const variables = ref<DraftVariable[]>([
  ...(props.draftVariables ?? props.profileVariables).map((variable) => {
    const persisted =
      variable.variableId === undefined
        ? undefined
        : profileVariablesById.get(variable.variableId);
    const replacement =
      variable.kind === "secret" && "value" in variable
        ? (variable.value ?? "")
        : "";
    return {
      rowKey: Symbol(variable.variableId ?? "variable-row"),
      ...(variable.variableId === undefined
        ? {}
        : { variableId: variable.variableId }),
      name: variable.name,
      kind: variable.kind,
      value: variable.kind === "value" ? variable.value : replacement,
      target: variable.kind === "alias" ? variable.target : "",
      description: variable.description ?? "",
      hasValue: persisted?.kind === "secret" && persisted.hasValue,
      secretTouched: replacement !== "",
      clearValue:
        variable.kind === "secret" &&
        "clearValue" in variable &&
        variable.clearValue === true,
    };
  }),
  ...(props.canEdit ? [createBlankVariable()] : []),
]);
const kindOptions = computed(() => [
  { value: "value", label: t("environment.kind.value") },
  { value: "secret", label: t("environment.kind.secret") },
  { value: "alias", label: t("environment.kind.alias") },
  { value: "unset", label: t("environment.kind.unset") },
]);
const expandedDescriptions = ref<symbol[]>([]);
const expandedInheritedDescriptions = ref<string[]>([]);

/** Creates the presentation-only row used to begin a new variable. */
function createBlankVariable(): DraftVariable {
  return {
    rowKey: Symbol("variable-row"),
    name: "",
    kind: "value",
    value: "",
    target: "",
    description: "",
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
    variable.description === "" &&
    !variable.secretTouched &&
    !variable.clearValue
  );
}

/** Toggles one row's inline description editor without coupling it to position. */
function toggleDescription(rowKey: symbol): void {
  expandedDescriptions.value = expandedDescriptions.value.includes(rowKey)
    ? expandedDescriptions.value.filter((candidate) => candidate !== rowKey)
    : [...expandedDescriptions.value, rowKey];
}

/** Builds the stable display key for one inherited variable declaration. */
function inheritedDescriptionKey(inherited: InheritedVariable): string {
  return `${inherited.source.scope}:${inherited.source.scopeId}:${inherited.variable.variableId}`;
}

/** Toggles one inherited variable's read-only description. */
function toggleInheritedDescription(inherited: InheritedVariable): void {
  const key = inheritedDescriptionKey(inherited);
  expandedInheritedDescriptions.value =
    expandedInheritedDescriptions.value.includes(key)
      ? expandedInheritedDescriptions.value.filter(
          (candidate) => candidate !== key,
        )
      : [...expandedInheritedDescriptions.value, key];
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
  emit("change", writes());
}

/** Handles text edits and materializes the next trailing blank variable. */
function updateVariable(): void {
  ensureTrailingBlankVariable();
  publishCount();
}

/** Reports whether a local declaration replaces one inherited variable. */
function isInheritedVariableOverridden(inherited: InheritedVariable): boolean {
  return variables.value.some(
    (variable) =>
      !isBlankVariable(variable) && variable.name === inherited.variable.name,
  );
}

/** Describes an inherited variable's source and local override state. */
function inheritedVariableDescription(inherited: InheritedVariable): string {
  const values = {
    scope: t(`variables.scope.${inherited.source.scope}`),
    name: inherited.source.scopeName,
  };
  return isInheritedVariableOverridden(inherited)
    ? t("variables.inheritedOverridden", values)
    : t("variables.inheritedFrom", values);
}

/** Removes one variable and publishes the new editor-local row count. */
function removeVariable(index: number): void {
  variables.value.splice(index, 1);
  ensureTrailingBlankVariable();
  publishCount();
}

/** Moves one variable while keeping the presentation-only blank row trailing. */
function moveVariable(fromIndex: number, toIndex: number): void {
  const [variable] = variables.value.splice(fromIndex, 1);
  if (variable !== undefined) variables.value.splice(toIndex, 0, variable);
  ensureTrailingBlankVariable();
  publishCount();
}

const variableReorder = useRowReorder({
  canMove: (index) =>
    variables.value[index] !== undefined &&
    !isBlankVariable(variables.value[index]),
  move: moveVariable,
  isDisabled: () => props.busy || !props.canEdit,
});

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
        ...(variable.description === ""
          ? {}
          : { description: variable.description }),
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
    <template
      v-for="(inherited, index) in inheritedVariables"
      :key="inheritedDescriptionKey(inherited)"
    >
      <div
        class="variable-field-row inherited-variable-row"
        :class="{
          'is-variable-overridden': isInheritedVariableOverridden(inherited),
        }"
      >
        <div class="field-key-cell">
          <TextInput
            :model-value="inherited.variable.name"
            class="field-cell-input"
            density="compact"
            font="mono"
            :aria-label="t('variables.inheritedName', { index: index + 1 })"
            disabled
          />
          <IconButton
            size="compact"
            class="field-description-action"
            :class="{
              'has-content': inherited.variable.description.trim() !== '',
            }"
            :label="t('documentation.viewFieldDescription')"
            :disabled="inherited.variable.description.trim() === ''"
            @click="toggleInheritedDescription(inherited)"
          >
            <FilePenLine :size="15" aria-hidden="true" />
          </IconButton>
        </div>
        <div class="variable-type-cell">
          <SelectMenu
            :model-value="inherited.variable.kind"
            :options="kindOptions"
            :label="t('variables.inheritedKind', { index: index + 1 })"
            density="compact"
            disabled
          />
        </div>
        <TextInput
          v-if="inherited.variable.kind === 'value'"
          :model-value="inherited.variable.value"
          class="field-cell-input"
          density="compact"
          font="mono"
          :aria-label="t('variables.inheritedValue', { index: index + 1 })"
          readonly
        />
        <TextInput
          v-else-if="inherited.variable.kind === 'alias'"
          :model-value="inherited.variable.target"
          class="field-cell-input"
          density="compact"
          font="mono"
          :aria-label="t('variables.inheritedTarget', { index: index + 1 })"
          readonly
        />
        <TextInput
          v-else-if="inherited.variable.kind === 'secret'"
          model-value=""
          class="field-cell-input"
          density="compact"
          font="mono"
          type="password"
          :placeholder="
            inherited.variable.hasValue
              ? t('environment.secretStoredPlaceholder')
              : t('environment.enterSecretValue')
          "
          :aria-label="t('variables.inheritedValue', { index: index + 1 })"
          readonly
        />
        <span
          v-else
          class="variable-field-empty-value"
          :aria-label="t('environment.noValue')"
        >
          —
        </span>
        <div class="row-actions">
          <span
            class="inherited-variable-indicator"
            role="img"
            :aria-label="inheritedVariableDescription(inherited)"
            :title="inheritedVariableDescription(inherited)"
          >
            <Lock :size="14" aria-hidden="true" />
          </span>
        </div>
      </div>
      <div
        v-if="
          expandedInheritedDescriptions.includes(
            inheritedDescriptionKey(inherited),
          )
        "
        class="field-description-row inherited-field-description"
        :class="{
          'is-variable-overridden': isInheritedVariableOverridden(inherited),
        }"
      >
        <TextInput
          :model-value="inherited.variable.description"
          :aria-label="t('documentation.fieldDescription')"
          :placeholder="t('documentation.fieldDescription')"
          disabled
        />
      </div>
    </template>
    <template v-for="(variable, index) in variables" :key="variable.rowKey">
      <div
        class="variable-field-row"
        :class="variableReorder.classes(index)"
        @dragover.stop="variableReorder.updateDropTarget($event, index)"
        @drop.stop="variableReorder.finishDrop($event)"
      >
        <div class="field-key-cell">
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
          <IconButton
            class="field-description-action"
            size="compact"
            :class="{ 'has-content': variable.description.trim() !== '' }"
            :label="t('documentation.editFieldDescription')"
            :disabled="busy || !canEdit || isBlankVariable(variable)"
            @click="toggleDescription(variable.rowKey)"
          >
            <FilePenLine :size="15" aria-hidden="true" />
          </IconButton>
        </div>
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
        <div class="row-actions">
          <RowReorderHandle
            v-if="!isBlankVariable(variable)"
            :label="
              t('common.actions.reorderRow', {
                item: t('environment.variables'),
                index: index + 1,
              })
            "
            :disabled="busy || !canEdit"
            @drag-start="variableReorder.startDrag($event, index)"
            @drag-end="variableReorder.cancelDrag"
            @move="variableReorder.moveByKeyboard(index, $event)"
          />
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
      <div
        v-if="expandedDescriptions.includes(variable.rowKey)"
        class="field-description-row"
      >
        <TextInput
          v-model="variable.description"
          :aria-label="t('documentation.fieldDescription')"
          :placeholder="t('documentation.fieldDescriptionPlaceholder')"
          :maxlength="4096"
          :disabled="busy || !canEdit"
          @input="updateVariable"
        />
      </div>
    </template>
  </div>
</template>
