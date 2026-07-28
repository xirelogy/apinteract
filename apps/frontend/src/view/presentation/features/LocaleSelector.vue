<script setup lang="ts">
import { computed } from "vue";
import { Languages } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { useTranslationService } from "@/app/i18n/translation-service";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";

const { t } = useI18n();
const translation = useTranslationService();
const localeOptions = computed(() => [
  { value: "system", label: t("common.language.system") },
  ...translation.locales.value.map((option) => ({
    value: option.locale,
    label: option.name,
  })),
]);

/** Applies the locale preference selected from the language menu. */
async function changeLocale(locale: string): Promise<void> {
  await translation.setPreference(locale);
}
</script>

<template>
  <SelectMenu
    class="locale-selector"
    :model-value="translation.preference.value"
    :options="localeOptions"
    :label="t('common.language.label')"
    density="compact"
    @update:model-value="changeLocale"
  >
    <template #selected="{ option }">
      <Languages :size="17" aria-hidden="true" />
      <span>{{ option?.label ?? t("common.language.system") }}</span>
    </template>
  </SelectMenu>
</template>
