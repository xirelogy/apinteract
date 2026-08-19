<script setup lang="ts">
import { computed } from "vue";
import {
  Folder,
  Layers3,
  LoaderCircle,
  PanelsTopLeft,
  Plus,
  Send,
  X,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  isWorkbenchTabDirty,
  workbenchTabId,
  type WorkbenchTab,
} from "@/model/domain/application";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";

const props = defineProps<{
  tabs: readonly WorkbenchTab[];
  activeTabId: string | null;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  activate: [tabId: string];
  close: [tabId: string];
  create: [];
}>();

const activeTab = computed(
  () =>
    props.tabs.find((tab) => workbenchTabId(tab) === props.activeTabId) ?? null,
);
const mobileOptions = computed(() =>
  props.tabs.map((tab) => ({
    value: workbenchTabId(tab),
    label: workbenchTabLabel(tab),
  })),
);

/** Formats one request for the compact mobile tab switcher. */
function workbenchTabLabel(tab: WorkbenchTab): string {
  const name = workbenchTabName(tab);
  const prefix =
    tab.kind === "request" ? `${tab.requestTab.draft.method} ` : "";
  return `${prefix}${name}${isWorkbenchTabDirty(tab) ? " *" : ""}`;
}

/** Returns the user-authored or fallback name for any workbench document. */
function workbenchTabName(tab: WorkbenchTab): string {
  if (tab.kind === "request") {
    return tab.requestTab.draft.name.trim() || t("request.untitled");
  }
  if (tab.kind === "environment") {
    return tab.draft.name.trim() || t("environment.create");
  }
  return tab.draft.name.trim();
}

/** Finds one tab for rendering a typed icon inside mobile menu options. */
function workbenchTabById(tabId: string): WorkbenchTab | null {
  return props.tabs.find((tab) => workbenchTabId(tab) === tabId) ?? null;
}

/** Selects the visual resource-kind icon for a workbench tab. */
function workbenchTabIcon(tab: WorkbenchTab | null) {
  if (tab?.kind === "workspace") return PanelsTopLeft;
  if (tab?.kind === "collection") return Folder;
  if (tab?.kind === "environment") return Layers3;
  return Send;
}

/** Reports whether a request tab currently owns a running execution. */
function isWorkbenchTabRunning(tab: WorkbenchTab | null): boolean {
  return (
    tab?.kind === "request" && tab.requestTab.execution?.state === "running"
  );
}

/** Formats the close action for the active mobile request. */
function closeTabLabel(tab: WorkbenchTab | null): string {
  return tab === null
    ? t("workbench.close")
    : t("workbench.closeNamed", {
        name: workbenchTabName(tab),
      });
}

/** Converts vertical wheel movement into horizontal movement for overflowing tabs. */
function handleTabWheel(event: WheelEvent): void {
  const list = event.currentTarget;
  if (
    !(list instanceof HTMLElement) ||
    event.ctrlKey ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
    list.scrollWidth <= list.clientWidth
  ) {
    return;
  }

  const pixelDelta =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * list.clientWidth
        : event.deltaY;
  const direction = getComputedStyle(list).direction === "rtl" ? -1 : 1;
  const previousScrollPosition = list.scrollLeft;
  list.scrollLeft += direction * pixelDelta;
  if (list.scrollLeft !== previousScrollPosition) {
    event.preventDefault();
  }
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
      emit("close", workbenchTabId(tab));
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
      emit("activate", workbenchTabId(tab));
    }
  }
}
</script>

<template>
  <div class="request-tab-strip">
    <div
      class="request-tab-list"
      role="tablist"
      :aria-label="t('workbench.openTabs')"
      @wheel="handleTabWheel"
      @keydown="handleTabKeydown"
    >
      <div
        v-for="tab in tabs"
        :key="workbenchTabId(tab)"
        class="request-tab"
        :class="{ 'is-active': workbenchTabId(tab) === activeTabId }"
      >
        <button
          :id="`request-tab-${workbenchTabId(tab)}`"
          class="request-tab-main"
          type="button"
          role="tab"
          :aria-selected="workbenchTabId(tab) === activeTabId"
          aria-controls="request-workbench"
          :tabindex="workbenchTabId(tab) === activeTabId ? 0 : -1"
          @click="emit('activate', workbenchTabId(tab))"
        >
          <span class="request-tab-label">
            <LoaderCircle
              v-if="isWorkbenchTabRunning(tab)"
              class="request-tab-spinner"
              :size="13"
              aria-hidden="true"
            />
            <Send
              v-else-if="tab.kind === 'request'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <PanelsTopLeft
              v-else-if="tab.kind === 'workspace'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <Folder
              v-else-if="tab.kind === 'collection'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <Layers3
              v-else
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <span v-if="tab.kind === 'request'" class="request-tab-method">
              {{ tab.requestTab.draft.method }}
            </span>
            <span class="request-tab-name">
              {{ workbenchTabName(tab) }}
            </span>
          </span>
          <span
            v-if="isWorkbenchTabDirty(tab)"
            class="request-tab-dirty"
            :title="t('request.unsavedChanges')"
            :aria-label="t('request.unsavedChanges')"
          ></span>
        </button>
        <IconButton
          class="request-tab-close"
          size="compact"
          :label="
            t('workbench.closeNamed', {
              name: workbenchTabName(tab),
            })
          "
          @click="emit('close', workbenchTabId(tab))"
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
        :label="t('workbench.openTabs')"
        :placeholder="t('workbench.noOpenTabs')"
        :disabled="tabs.length === 0"
        density="compact"
        mobile-presentation="popover"
        @update:model-value="emit('activate', $event)"
      >
        <template #option="{ option }">
          <span class="request-tab-label">
            <component
              :is="workbenchTabIcon(workbenchTabById(option.value))"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <span class="request-tab-name">{{ option.label }}</span>
          </span>
        </template>
        <template #selected>
          <span class="request-tab-label">
            <LoaderCircle
              v-if="isWorkbenchTabRunning(activeTab)"
              class="request-tab-spinner"
              :size="14"
              aria-hidden="true"
            />
            <Send
              v-else-if="activeTab?.kind === 'request'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <PanelsTopLeft
              v-else-if="activeTab?.kind === 'workspace'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <Folder
              v-else-if="activeTab?.kind === 'collection'"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <Layers3
              v-else-if="activeTab"
              class="request-tab-kind-icon"
              :size="14"
              aria-hidden="true"
            />
            <span
              v-if="activeTab?.kind === 'request'"
              class="request-tab-method"
            >
              {{ activeTab.requestTab.draft.method }}
            </span>
            <span class="request-tab-name">
              {{
                activeTab === null
                  ? t("workbench.noOpenTabs")
                  : workbenchTabName(activeTab)
              }}
            </span>
          </span>
          <span
            v-if="activeTab && isWorkbenchTabDirty(activeTab)"
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
        @click="activeTab && emit('close', workbenchTabId(activeTab))"
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
