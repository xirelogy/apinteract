<script setup lang="ts">
import { Languages } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { useTranslationService } from "@/app/i18n/translation-service";

const { t } = useI18n();
const translation = useTranslationService();

/** Applies the locale preference selected from the native language control. */
async function changeLocale(event: Event): Promise<void> {
  await translation.setPreference((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <label class="locale-selector" :title="t('common.language.label')">
    <Languages :size="17" aria-hidden="true" />
    <span class="visually-hidden">{{ t("common.language.label") }}</span>
    <select
      class="locale-select"
      :value="translation.preference.value"
      :aria-label="t('common.language.label')"
      @change="changeLocale"
    >
      <option value="system">{{ t("common.language.system") }}</option>
      <option
        v-for="option in translation.locales.value"
        :key="option.locale"
        :value="option.locale"
      >
        {{ option.name }}
      </option>
    </select>
  </label>
</template>
