<script setup lang="ts">
import { LogOut, Menu, Radio, X } from "@lucide/vue";

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
          navigatorOpen
            ? 'Close workspace navigator'
            : 'Open workspace navigator'
        "
        :aria-label="
          navigatorOpen
            ? 'Close workspace navigator'
            : 'Open workspace navigator'
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
        {{ connected ? "Connected" : "Offline" }}
      </span>
      <span class="user-name">{{ displayName }}</span>
      <button
        class="icon-button"
        type="button"
        title="Log out"
        :aria-label="`Log out ${displayName}`"
        @click="$emit('logout')"
      >
        <LogOut :size="18" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
