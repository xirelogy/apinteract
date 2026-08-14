<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  parseAppendingHeaderNames,
  useHeaderPreferences,
} from "@/app/preferences/header-preferences";
import {
  type DisplayStyle,
  useDisplayStylePreference,
} from "@/app/preferences/display-style";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import TextArea from "@/view/presentation/controls/TextArea.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import TabsList from "@/view/presentation/controls/tabs/TabsList.vue";
import TabsPanel from "@/view/presentation/controls/tabs/TabsPanel.vue";
import TabsRoot from "@/view/presentation/controls/tabs/TabsRoot.vue";
import TabsTrigger from "@/view/presentation/controls/tabs/TabsTrigger.vue";
import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();
const { t } = useI18n();
const headerPreferences = useHeaderPreferences();
const displayStylePreference = useDisplayStylePreference();
const activeSection = ref<"general" | "defaults">("general");
const displayStyle = ref<DisplayStyle>("system");
const appendingHeaders = ref("");
const displayStyleOptions = computed(() => [
  { value: "system", label: t("header.displayStyle.system") },
  { value: "light", label: t("header.displayStyle.light") },
  { value: "dark", label: t("header.displayStyle.dark") },
]);
const parsedAppendingHeaders = computed(() =>
  parseAppendingHeaderNames(appendingHeaders.value),
);
const appendingHeadersError = computed(() =>
  parsedAppendingHeaders.value.invalidNames.length === 0
    ? undefined
    : t("header.appendingHeadersInvalid"),
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = "general";
      displayStyle.value = displayStylePreference.displayStyle.value;
      appendingHeaders.value =
        headerPreferences.appendingHeaderNames.value.join("\n");
    }
  },
  { immediate: true },
);

/** Dismisses the dialog without persisting staged header defaults. */
function close(): void {
  emit("update:open", false);
}

/** Persists the header defaults shared by every editor before closing. */
function save(): void {
  if (appendingHeadersError.value !== undefined) return;
  displayStylePreference.setDisplayStyle(displayStyle.value);
  headerPreferences.setAppendingHeaderNames(parsedAppendingHeaders.value.names);
  close();
}

/** Accepts only display styles represented by the controlled option list. */
function selectDisplayStyle(value: string): void {
  if (value === "system" || value === "light" || value === "dark") {
    displayStyle.value = value;
  }
}
</script>

<template>
  <DialogControl
    :open="open"
    class="resource-dialog account-options-dialog"
    aria-labelledby="account-options-dialog-title"
    @update:open="emit('update:open', $event)"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="account-options-dialog-title">{{ t("header.options") }}</h2>
        <IconButton :label="t('common.actions.close')" @click="close">
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="resource-dialog-form">
        <TabsRoot v-model="activeSection" class="account-options-tabs">
          <TabsList class="request-tabs" :label="t('header.options')">
            <TabsTrigger class="tab-button" value="general">
              {{ t("header.optionsSections.general") }}
            </TabsTrigger>
            <TabsTrigger class="tab-button" value="defaults">
              {{ t("header.optionsSections.defaults") }}
            </TabsTrigger>
          </TabsList>
          <TabsPanel value="general" class="account-options-section">
            <FormField
              v-slot="{ controlId }"
              :label="t('common.language.label')"
            >
              <LocaleSelector
                :input-id="controlId"
                density="default"
                mobile-presentation="popover"
              />
            </FormField>
            <FormField
              v-slot="{ controlId }"
              :label="t('header.displayStyle.label')"
            >
              <SelectMenu
                :input-id="controlId"
                :model-value="displayStyle"
                :options="displayStyleOptions"
                :label="t('header.displayStyle.label')"
                mobile-presentation="popover"
                @update:model-value="selectDisplayStyle"
              />
            </FormField>
          </TabsPanel>
          <TabsPanel value="defaults" class="account-options-section">
            <FormField
              v-slot="{ controlId, describedBy, invalid }"
              :label="t('header.appendingHeaders')"
              v-bind="
                appendingHeadersError === undefined
                  ? {}
                  : { error: appendingHeadersError }
              "
            >
              <TextArea
                :id="controlId"
                v-model="appendingHeaders"
                class="appending-headers-input"
                font="mono"
                :aria-describedby="describedBy"
                :invalid="invalid"
                spellcheck="false"
              />
            </FormField>
          </TabsPanel>
        </TabsRoot>
        <footer class="resource-dialog-actions">
          <ButtonControl
            variant="primary"
            :disabled="appendingHeadersError !== undefined"
            @click="save"
          >
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </DialogControl>
</template>
