<script setup lang="ts">
import { computed } from "vue";
import { LoaderCircle, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { isRequestTabDirty, type RequestTab } from "@/model/domain/application";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";

const props = defineProps<{
  tabs: readonly RequestTab[];
  activeTabId: string | null;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  activate: [tabId: string];
  close: [tabId: string];
  create: [];
}>();

const activeTab = computed(
  () => props.tabs.find((tab) => tab.tabId === props.activeTabId) ?? null,
);
const mobileOptions = computed(() =>
  props.tabs.map((tab) => ({
    value: tab.tabId,
    label: requestTabLabel(tab),
  })),
);

/** Formats one request for the compact mobile tab switcher. */
function requestTabLabel(tab: RequestTab): string {
  const name = tab.draft.name.trim() || t("request.untitled");
  return `${tab.draft.method} ${name}${isRequestTabDirty(tab) ? " *" : ""}`;
}

/** Formats the close action for the active mobile request. */
function closeTabLabel(tab: RequestTab | null): string {
  return tab === null
    ? t("request.close")
    : t("request.closeNamed", {
        name: tab.draft.name || t("request.untitled"),
      });
}

/** Provides roving focus, activation, and deletion for request document tabs. */
function handleTabKeydown(event: KeyboardEvent): void {
  const list = event.currentTarget;
  if (!(list instanceof HTMLElement)) {
    return;
  }
  const triggers = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const currentIndex = triggers.findIndex(
    (trigger) => trigger === document.activeElement,
  );
  if (currentIndex === -1 || triggers.length === 0) {
    return;
  }
  if (event.key === "Delete") {
    event.preventDefault();
    const tab = props.tabs[currentIndex];
    if (tab !== undefined) {
      emit("close", tab.tabId);
    }
    return;
  }
  const rtl = document.documentElement.dir === "rtl";
  let nextIndex: number | null = null;
  if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = triggers.length - 1;
  } else if (event.key === "ArrowLeft") {
    nextIndex =
      (currentIndex + (rtl ? 1 : -1) + triggers.length) % triggers.length;
  } else if (event.key === "ArrowRight") {
    nextIndex =
      (currentIndex + (rtl ? -1 : 1) + triggers.length) % triggers.length;
  }
  if (nextIndex !== null) {
    event.preventDefault();
    triggers[nextIndex]?.focus();
    const tab = props.tabs[nextIndex];
    if (tab !== undefined) {
      emit("activate", tab.tabId);
    }
  }
}
</script>

<template>
  <div class="request-tab-strip">
    <div
      class="request-tab-list"
      role="tablist"
      :aria-label="t('request.openRequests')"
      @keydown="handleTabKeydown"
    >
      <div
        v-for="tab in tabs"
        :key="tab.tabId"
        class="request-tab"
        :class="{ 'is-active': tab.tabId === activeTabId }"
      >
        <button
          :id="`request-tab-${tab.tabId}`"
          class="request-tab-main"
          type="button"
          role="tab"
          :aria-selected="tab.tabId === activeTabId"
          aria-controls="request-workbench"
          :tabindex="tab.tabId === activeTabId ? 0 : -1"
          @click="emit('activate', tab.tabId)"
        >
          <span class="request-tab-label">
            <LoaderCircle
              v-if="tab.execution?.state === 'running'"
              class="request-tab-spinner"
              :size="13"
              aria-hidden="true"
            />
            <span v-else class="request-tab-method">{{
              tab.draft.method
            }}</span>
            <span class="request-tab-name">
              {{ tab.draft.name.trim() || t("request.untitled") }}
            </span>
          </span>
          <span
            v-if="isRequestTabDirty(tab)"
            class="request-tab-dirty"
            :title="t('request.unsavedChanges')"
            :aria-label="t('request.unsavedChanges')"
          ></span>
        </button>
        <IconButton
          class="request-tab-close"
          size="compact"
          :label="
            t('request.closeNamed', {
              name: tab.draft.name || t('request.untitled'),
            })
          "
          @click="emit('close', tab.tabId)"
        >
          <X :size="14" aria-hidden="true" />
        </IconButton>
      </div>
    </div>
    <div class="request-tab-mobile">
      <SelectMenu
        class="request-tab-mobile-switcher"
        :model-value="activeTabId ?? ''"
        :options="mobileOptions"
        :label="t('request.openRequests')"
        :placeholder="t('request.noOpenRequests')"
        :disabled="tabs.length === 0"
        density="compact"
        mobile-presentation="popover"
        @update:model-value="emit('activate', $event)"
      >
        <template #selected>
          <span class="request-tab-label">
            <LoaderCircle
              v-if="activeTab?.execution?.state === 'running'"
              class="request-tab-spinner"
              :size="14"
              aria-hidden="true"
            />
            <span v-else-if="activeTab" class="request-tab-method">
              {{ activeTab.draft.method }}
            </span>
            <span class="request-tab-name">
              {{
                activeTab === null
                  ? t("request.noOpenRequests")
                  : activeTab.draft.name.trim() || t("request.untitled")
              }}
            </span>
          </span>
          <span
            v-if="activeTab && isRequestTabDirty(activeTab)"
            class="request-tab-dirty"
            :title="t('request.unsavedChanges')"
            :aria-label="t('request.unsavedChanges')"
          ></span>
        </template>
      </SelectMenu>
      <IconButton
        class="request-tab-mobile-close"
        :label="closeTabLabel(activeTab)"
        :disabled="activeTab === null"
        @click="activeTab && emit('close', activeTab.tabId)"
      >
        <X :size="16" aria-hidden="true" />
      </IconButton>
    </div>
    <IconButton
      class="request-tab-add"
      :label="t('request.newTemporary')"
      @click="emit('create')"
    >
      <Plus :size="17" aria-hidden="true" />
    </IconButton>
  </div>
</template>
