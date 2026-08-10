<script setup lang="ts">
import { computed, ref } from "vue";
import { LogOut, Menu, Settings, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ActionMenu from "@/view/presentation/controls/ActionMenu.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AccountOptionsDialog from "@/view/presentation/features/AccountOptionsDialog.vue";
import LogoutConfirmationDialog from "@/view/presentation/features/LogoutConfirmationDialog.vue";

const { t } = useI18n();
const optionsOpen = ref(false);
const logoutConfirmationOpen = ref(false);
const accountActions = computed(() => [
  { value: "options", label: t("header.options") },
  { value: "logout", label: t("header.logoutAction") },
]);

defineProps<{
  username: string;
  navigatorOpen: boolean;
}>();

defineEmits<{
  logout: [];
  toggleNavigator: [];
}>();

/** Opens the dialog associated with an account-menu selection. */
function selectAccountAction(action: string): void {
  if (action === "options") {
    optionsOpen.value = true;
  } else if (action === "logout") {
    logoutConfirmationOpen.value = true;
  }
}
</script>

<template>
  <header class="app-header">
    <div class="header-leading">
      <IconButton
        class="navigator-toggle-button"
        :label="
          navigatorOpen ? t('header.closeNavigator') : t('header.openNavigator')
        "
        :aria-expanded="navigatorOpen"
        aria-controls="workspace-navigator"
        @click="$emit('toggleNavigator')"
      >
        <X v-if="navigatorOpen" :size="19" aria-hidden="true" />
        <Menu v-else :size="19" aria-hidden="true" />
      </IconButton>
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">API</span>
        <span class="brand-name">APInteract</span>
      </div>
    </div>
    <div class="header-actions">
      <ActionMenu
        class="account-menu"
        :label="t('header.accountMenu', { name: username })"
        :items="accountActions"
        @select="selectAccountAction"
      >
        <template #trigger="{ open, popupId, toggle, keydown }">
          <button
            class="account-menu-trigger"
            type="button"
            aria-haspopup="menu"
            :aria-label="t('header.accountMenu', { name: username })"
            :aria-expanded="open"
            :aria-controls="open ? popupId : undefined"
            @click="toggle"
            @keydown="keydown"
          >
            {{ username }}
          </button>
        </template>
        <template #item="{ item }">
          <Settings
            v-if="item.value === 'options'"
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <LogOut
            v-else
            class="action-menu-item-icon"
            :size="16"
            aria-hidden="true"
          />
          <span>{{ item.label }}</span>
        </template>
      </ActionMenu>
    </div>
  </header>
  <AccountOptionsDialog v-model:open="optionsOpen" />
  <LogoutConfirmationDialog
    v-model:open="logoutConfirmationOpen"
    @confirm="$emit('logout')"
  />
</template>
