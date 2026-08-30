<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { CalendarClock, Monitor, Moon, Sun, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  parseAppendingHeaderNames,
  useHeaderPreferences,
} from "@/app/preferences/header-preferences";
import {
  type DisplayStyle,
  useDisplayStylePreference,
} from "@/app/preferences/display-style";
import {
  type DateTimeFormat,
  formatDateTime,
  isDateTimeFormat,
  useDateTimeFormatPreference,
} from "@/app/preferences/date-time-format";
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
import { applicationControllerKey } from "@/app/dependencies";
import { useApplicationStore } from "@/control/state/application-store";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();
const { locale, t } = useI18n();
const controller = inject(applicationControllerKey, null);
const store = useApplicationStore();
const headerPreferences = useHeaderPreferences();
const displayStylePreference = useDisplayStylePreference();
const dateTimeFormatPreference = useDateTimeFormatPreference();
const activeSection = ref<"general" | "defaults" | "plugins">("general");
const displayStyle = ref<DisplayStyle>("system");
const dateTimeFormat = ref<DateTimeFormat>("locale");
const appendingHeaders = ref("");
const dateTimeExample = new Date();
const displayStyleOptions = computed(() => [
  { value: "system", label: t("header.displayStyle.system") },
  { value: "light", label: t("header.displayStyle.light") },
  { value: "dark", label: t("header.displayStyle.dark") },
]);
const dateTimeFormatOptions = computed(() =>
  [
    {
      value: "locale" as const,
      name: t("header.dateTimeFormat.localeDefault"),
    },
    { value: "ymd-24" as const, name: "YYYY-MM-DD HH:mm:ss" },
    { value: "ymd-12" as const, name: "YYYY-MM-DD hh:mm:ss A" },
    { value: "dmy-24" as const, name: "DD/MM/YYYY HH:mm:ss" },
    { value: "mdy-12" as const, name: "MM/DD/YYYY hh:mm:ss A" },
    { value: "iso8601" as const, name: "ISO 8601" },
  ].map((option) => ({
    value: option.value,
    label: `${option.name} — ${formatDateTime(
      dateTimeExample,
      locale.value,
      option.value,
    )}`,
  })),
);
const parsedAppendingHeaders = computed(() =>
  parseAppendingHeaderNames(appendingHeaders.value),
);
const appendingHeadersError = computed(() =>
  parsedAppendingHeaders.value.invalidNames.length === 0
    ? undefined
    : t("header.appendingHeadersInvalid"),
);
const pluginsEmpty = computed(
  () => store.plugins.length === 0 && store.pluginListState !== "loading",
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = "general";
      displayStyle.value = displayStylePreference.displayStyle.value;
      dateTimeFormat.value = dateTimeFormatPreference.dateTimeFormat.value;
      appendingHeaders.value =
        headerPreferences.appendingHeaderNames.value.join("\n");
      void controller?.loadPlugins();
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
  dateTimeFormatPreference.setDateTimeFormat(dateTimeFormat.value);
  headerPreferences.setAppendingHeaderNames(parsedAppendingHeaders.value.names);
  close();
}

/** Accepts only display styles represented by the controlled option list. */
function selectDisplayStyle(value: string): void {
  if (value === "system" || value === "light" || value === "dark") {
    displayStyle.value = value;
  }
}

/** Accepts only date/time formats represented by the controlled option list. */
function selectDateTimeFormat(value: string): void {
  if (isDateTimeFormat(value)) dateTimeFormat.value = value;
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
            <TabsTrigger class="tab-button" value="plugins">
              {{ t("header.optionsSections.plugins") }}
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
              >
                <template #selected="{ option }">
                  <Monitor
                    v-if="displayStyle === 'system'"
                    :size="17"
                    aria-hidden="true"
                  />
                  <Sun
                    v-else-if="displayStyle === 'light'"
                    :size="17"
                    aria-hidden="true"
                  />
                  <Moon v-else :size="17" aria-hidden="true" />
                  <span>
                    {{ option?.label ?? t("header.displayStyle.system") }}
                  </span>
                </template>
              </SelectMenu>
            </FormField>
            <FormField
              v-slot="{ controlId }"
              :label="t('header.dateTimeFormat.label')"
            >
              <SelectMenu
                :input-id="controlId"
                :model-value="dateTimeFormat"
                :options="dateTimeFormatOptions"
                :label="t('header.dateTimeFormat.label')"
                mobile-presentation="popover"
                @update:model-value="selectDateTimeFormat"
              >
                <template #selected="{ option }">
                  <CalendarClock :size="17" aria-hidden="true" />
                  <span>
                    {{
                      option?.label ?? t("header.dateTimeFormat.localeDefault")
                    }}
                  </span>
                </template>
              </SelectMenu>
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
          <TabsPanel value="plugins" class="account-options-section">
            <p v-if="store.pluginListState === 'loading'" role="status">
              {{ t("header.plugins.loading") }}
            </p>
            <p
              v-else-if="store.pluginListState === 'unavailable'"
              class="plugin-list-notice"
              role="status"
            >
              {{ t("header.plugins.unavailable") }}
            </p>
            <p v-if="pluginsEmpty">
              {{ t("header.plugins.empty") }}
            </p>
            <ul
              v-else
              class="plugin-list"
              :aria-label="t('header.plugins.label')"
            >
              <li
                v-for="plugin in store.plugins"
                :key="plugin.id"
                class="plugin-list-item"
              >
                <span class="plugin-list-name">{{ plugin.name }}</span>
                <span class="plugin-list-version">v{{ plugin.version }}</span>
                <span class="plugin-badge">{{
                  t(`header.plugins.targets.${plugin.target}`)
                }}</span>
                <span class="plugin-badge">{{
                  t(`header.plugins.sources.${plugin.source}`)
                }}</span>
              </li>
            </ul>
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
