<script setup lang="ts">
import { LogOut, Radio } from "@lucide/vue";

defineProps<{
  displayName: string;
  connected: boolean;
}>();

defineEmits<{
  logout: [];
}>();
</script>

<template>
  <header class="app-header">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true">API</span>
      <span class="brand-name">APInteract</span>
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
        aria-label="Log out"
        @click="$emit('logout')"
      >
        <LogOut :size="18" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
