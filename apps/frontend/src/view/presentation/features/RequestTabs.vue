<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Check, ChevronDown, LoaderCircle, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { isRequestTabDirty, type RequestTab } from "@/model/domain/application";

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
const mobileSwitcher = ref<HTMLElement | null>(null);
const mobileMenuOpen = ref(false);

onMounted(() => {
  document.addEventListener("pointerdown", closeMobileMenuFromOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeMobileMenuFromOutside);
});

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

/** Toggles the anchored mobile request menu. */
function toggleMobileMenu(): void {
  if (props.tabs.length > 0) {
    mobileMenuOpen.value = !mobileMenuOpen.value;
  }
}

/** Activates one mobile request and closes the request menu. */
function activateMobileTab(tabId: string): void {
  emit("activate", tabId);
  mobileMenuOpen.value = false;
}

/** Closes the mobile request menu when interaction leaves its anchor. */
function closeMobileMenuFromOutside(event: PointerEvent): void {
  if (
    event.target instanceof Node &&
    !mobileSwitcher.value?.contains(event.target)
  ) {
    mobileMenuOpen.value = false;
  }
}
</script>

<template>
  <div class="request-tab-strip">
    <div
      class="request-tab-list"
      role="tablist"
      :aria-label="t('request.openRequests')"
    >
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
          <span class="request-tab-name">
            {{ tab.draft.name.trim() || t("request.untitled") }}
          </span>
          <span
            v-if="isRequestTabDirty(tab)"
            class="request-tab-dirty"
            :title="t('request.unsavedChanges')"
            :aria-label="t('request.unsavedChanges')"
          ></span>
        </button>
        <button
          class="request-tab-close"
          type="button"
          :title="
            t('request.closeNamed', {
              name: tab.draft.name || t('request.untitled'),
            })
          "
          :aria-label="
            t('request.closeNamed', {
              name: tab.draft.name || t('request.untitled'),
            })
          "
          @click="emit('close', tab.tabId)"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div class="request-tab-mobile">
      <div
        ref="mobileSwitcher"
        class="request-tab-mobile-switcher"
        @keydown.esc.stop="mobileMenuOpen = false"
      >
        <button
          class="request-tab-trigger"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="mobileMenuOpen"
          :aria-label="
            activeTab === null
              ? t('request.noOpenRequests')
              : t('request.current', { name: requestTabLabel(activeTab) })
          "
          :disabled="tabs.length === 0"
          @click="toggleMobileMenu"
        >
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
          <span
            v-if="activeTab && isRequestTabDirty(activeTab)"
            class="request-tab-dirty"
            :title="t('request.unsavedChanges')"
            :aria-label="t('request.unsavedChanges')"
          ></span>
          <ChevronDown
            class="request-tab-menu-chevron"
            :class="{ 'is-open': mobileMenuOpen }"
            :size="16"
            aria-hidden="true"
          />
        </button>
        <div
          v-if="mobileMenuOpen"
          class="request-tab-menu"
          role="menu"
          :aria-label="t('request.openRequests')"
        >
          <button
            v-for="tab in tabs"
            :key="tab.tabId"
            class="request-tab-menu-item"
            :class="{ 'is-active': tab.tabId === activeTabId }"
            type="button"
            role="menuitemradio"
            :aria-checked="tab.tabId === activeTabId"
            @click="activateMobileTab(tab.tabId)"
          >
            <Check
              v-if="tab.tabId === activeTabId"
              :size="15"
              aria-hidden="true"
            />
            <span v-else class="request-tab-menu-spacer" aria-hidden="true">
            </span>
            <LoaderCircle
              v-if="tab.execution?.state === 'running'"
              class="request-tab-spinner"
              :size="13"
              aria-hidden="true"
            />
            <span v-else class="request-tab-method">
              {{ tab.draft.method }}
            </span>
            <span class="request-tab-name">
              {{ tab.draft.name.trim() || t("request.untitled") }}
            </span>
            <span
              v-if="isRequestTabDirty(tab)"
              class="request-tab-dirty"
              :title="t('request.unsavedChanges')"
              :aria-label="t('request.unsavedChanges')"
            ></span>
          </button>
        </div>
      </div>
      <button
        class="icon-button request-tab-mobile-close"
        type="button"
        :title="closeTabLabel(activeTab)"
        :aria-label="closeTabLabel(activeTab)"
        :disabled="activeTab === null"
        @click="activeTab && emit('close', activeTab.tabId)"
      >
        <X :size="16" aria-hidden="true" />
      </button>
    </div>
    <button
      class="icon-button request-tab-add"
      type="button"
      :title="t('request.newTemporary')"
      :aria-label="t('request.newTemporary')"
      @click="emit('create')"
    >
      <Plus :size="17" aria-hidden="true" />
    </button>
  </div>
</template>
