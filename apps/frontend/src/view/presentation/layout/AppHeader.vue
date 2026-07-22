<script setup lang="ts">
import { LogOut, Menu, Radio, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";

const { t } = useI18n();

defineProps<{
  displayName: string;
  connected: boolean;
  navigatorOpen: boolean;
}>();

defineEmits<{
  logout: [];
  toggleNavigator: [];
}>();
</script>

<template>
  <header class="app-header">
    <div class="header-leading">
      <button
        class="icon-button navigator-toggle-button"
        type="button"
        :title="
          navigatorOpen ? t('header.closeNavigator') : t('header.openNavigator')
        "
        :aria-label="
          navigatorOpen ? t('header.closeNavigator') : t('header.openNavigator')
        "
        :aria-expanded="navigatorOpen"
        aria-controls="workspace-navigator"
        @click="$emit('toggleNavigator')"
      >
        <X v-if="navigatorOpen" :size="19" aria-hidden="true" />
        <Menu v-else :size="19" aria-hidden="true" />
      </button>
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">API</span>
        <span class="brand-name">APInteract</span>
      </div>
    </div>
    <div class="header-actions">
      <span class="connection-state" :data-connected="connected">
        <Radio :size="15" aria-hidden="true" />
        {{ connected ? t("header.connected") : t("header.offline") }}
      </span>
      <LocaleSelector />
      <span class="user-name">{{ displayName }}</span>
      <button
        class="icon-button"
        type="button"
        :title="t('header.logout', { name: displayName })"
        :aria-label="t('header.logout', { name: displayName })"
        @click="$emit('logout')"
      >
        <LogOut :size="18" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
