<script setup lang="ts">
import { LoaderCircle, Plus, X } from "@lucide/vue";

import { isRequestTabDirty, type RequestTab } from "@/model/domain/application";

defineProps<{
  tabs: readonly RequestTab[];
  activeTabId: string | null;
}>();

const emit = defineEmits<{
  activate: [tabId: string];
  close: [tabId: string];
  create: [];
}>();
</script>

<template>
  <div class="request-tab-strip">
    <div class="request-tab-list" role="tablist" aria-label="Open requests">
      <div
        v-for="tab in tabs"
        :key="tab.tabId"
        class="request-tab"
        :class="{ 'is-active': tab.tabId === activeTabId }"
      >
        <button
          class="request-tab-main"
          type="button"
          role="tab"
          :aria-selected="tab.tabId === activeTabId"
          @click="emit('activate', tab.tabId)"
        >
          <LoaderCircle
            v-if="tab.execution?.state === 'running'"
            class="request-tab-spinner"
            :size="13"
            aria-hidden="true"
          />
          <span v-else class="request-tab-method">{{ tab.draft.method }}</span>
          <span class="request-tab-name">{{ tab.draft.name }}</span>
          <span
            v-if="isRequestTabDirty(tab)"
            class="request-tab-dirty"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          ></span>
        </button>
        <button
          class="request-tab-close"
          type="button"
          :title="`Close ${tab.draft.name}`"
          :aria-label="`Close ${tab.draft.name}`"
          @click="emit('close', tab.tabId)"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>
    <button
      class="icon-button request-tab-add"
      type="button"
      title="New temporary request"
      aria-label="New temporary request"
      @click="emit('create')"
    >
      <Plus :size="17" aria-hidden="true" />
    </button>
  </div>
</template>
