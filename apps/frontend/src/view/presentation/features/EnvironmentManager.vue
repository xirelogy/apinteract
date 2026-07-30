<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Plus, Settings, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type {
  EnvironmentSummary,
  EnvironmentVariableWrite,
  EnvironmentView,
} from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";

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
  environments: readonly EnvironmentSummary[];
  selectedEnvironmentId: string | null;
  environment: EnvironmentView | null;
  canEdit: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  select: [environmentId: string | null];
  load: [environmentId: string];
  create: [name: string, variables: readonly EnvironmentVariableWrite[]];
  save: [
    environmentId: string,
    revision: number,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
  ];
  delete: [environmentId: string, revision: number];
}>();
const { t } = useI18n();
const open = ref(false);
const name = ref("");
const variables = ref<DraftVariable[]>([]);
const editingId = ref<string | null>(null);
const options = computed(() => [
  { value: "", label: t("environment.none") },
  ...props.environments.map((environment) => ({
    value: environment.environmentId,
    label: environment.name,
  })),
]);
const kindOptions = computed(() => [
  { value: "value", label: t("environment.kind.value") },
  { value: "secret", label: t("environment.kind.secret") },
  { value: "alias", label: t("environment.kind.alias") },
  { value: "unset", label: t("environment.kind.unset") },
]);

watch(
  () => props.environment,
  (environment) => {
    if (
      environment === null ||
      (editingId.value !== null &&
        environment.environmentId !== editingId.value)
    ) {
      return;
    }
    editingId.value = environment.environmentId;
    name.value = environment.name;
    variables.value = environment.variables.map((variable) => ({
      variableId: variable.variableId,
      name: variable.name,
      kind: variable.kind,
      value: variable.kind === "value" ? variable.value : "",
      target: variable.kind === "alias" ? variable.target : "",
      hasValue: variable.kind === "secret" && variable.hasValue,
      secretTouched: false,
      clearValue: false,
    }));
  },
);

/** Opens the manager with a clean create form. */
function createEnvironment(): void {
  editingId.value = null;
  name.value = "";
  variables.value = [];
  open.value = true;
}

/** Opens and requests one redacted environment profile. */
function editEnvironment(environmentId: string): void {
  editingId.value = environmentId;
  name.value = "";
  variables.value = [];
  open.value = true;
  emit("load", environmentId);
}

/** Adds one ordinary variable at the end of presentation order. */
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

/** Changes kind only for an unsaved variable and marks new secrets explicit. */
function changeKind(variable: DraftVariable, kind: string): void {
  if (variable.variableId !== undefined) {
    return;
  }
  variable.kind = kind as DraftVariable["kind"];
  if (variable.kind === "secret" && !variable.hasValue) {
    variable.secretTouched = true;
  }
}

/** Marks a secret input as an intentional replacement, including empty text. */
function updateSecret(variable: DraftVariable, value: string): void {
  variable.value = value;
  variable.secretTouched = true;
  variable.clearValue = false;
}

/** Reports whether a redacted stored-secret indicator remains authoritative. */
function showStoredSecret(variable: DraftVariable): boolean {
  return variable.hasValue && !variable.secretTouched && !variable.clearValue;
}

/** Converts local redacted rows into the write-only command union. */
function variableWrites(): EnvironmentVariableWrite[] {
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

/** Emits create or optimistic update from the current complete profile. */
function save(): void {
  const writes = variableWrites();
  const environment = props.environment;
  if (editingId.value === null) {
    emit("create", name.value, writes);
  } else if (environment?.environmentId === editingId.value) {
    emit(
      "save",
      environment.environmentId,
      environment.revision,
      name.value,
      writes,
    );
  }
}

/** Closes the editor only after its owning controller confirms persistence. */
function finishMutation(): void {
  open.value = false;
}

defineExpose({ finishMutation });

/** Confirms destructive deletion using the browser's accessible prompt. */
function deleteEnvironment(): void {
  const environment = props.environment;
  if (
    environment !== null &&
    window.confirm(
      t("environment.deleteConfirmation", { name: environment.name }),
    )
  ) {
    emit("delete", environment.environmentId, environment.revision);
  }
}
</script>

<template>
  <section class="environment-toolbar" :aria-label="t('environment.label')">
    <SelectMenu
      :model-value="selectedEnvironmentId ?? ''"
      :options="options"
      :label="t('environment.select')"
      density="compact"
      :disabled="busy || !canEdit"
      @update:model-value="emit('select', $event || null)"
    />
    <IconButton
      :label="t('environment.manage')"
      :disabled="busy"
      @click="
        selectedEnvironmentId
          ? editEnvironment(selectedEnvironmentId)
          : createEnvironment()
      "
    >
      <Settings :size="17" aria-hidden="true" />
    </IconButton>
  </section>

  <DialogControl
    v-model:open="open"
    class="resource-dialog environment-dialog"
    aria-labelledby="environment-dialog-title"
    :busy="busy"
  >
    <div class="resource-dialog-surface">
      <form class="resource-dialog-form" @submit.prevent="save">
        <header class="resource-dialog-header">
          <h2 id="environment-dialog-title">
            {{ editingId ? t("environment.edit") : t("environment.create") }}
          </h2>
        </header>
        <label class="field-label">
          {{ t("common.fields.name") }}
          <TextInput
            v-model="name"
            :disabled="busy || !canEdit"
            required
            autocomplete="off"
          />
        </label>
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
          {{ t("environment.noVariables") }}
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
              :placeholder="
                variable.hasValue ? t('environment.replaceSecret') : ''
              "
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
        <footer class="resource-dialog-actions">
          <ButtonControl
            type="button"
            variant="secondary"
            :disabled="busy"
            @click="open = false"
          >
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl
            v-if="editingId && canEdit"
            type="button"
            variant="danger"
            :disabled="busy"
            @click="deleteEnvironment"
          >
            {{ t("common.actions.delete") }}
          </ButtonControl>
          <ButtonControl
            v-if="canEdit"
            type="submit"
            variant="primary"
            :busy="busy"
          >
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </form>
    </div>
  </DialogControl>
</template>
