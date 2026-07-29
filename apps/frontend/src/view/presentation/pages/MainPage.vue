<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import { useApplicationStore } from "@/control/state/application-store";
import type { RequestField } from "@/model/contracts/backend";
import {
  isRequestTabDirty,
  type RequestDraftInput,
  type RequestTab,
} from "@/model/domain/application";
import AppHeader from "@/view/presentation/layout/AppHeader.vue";
import DiscardChangesDialog from "@/view/presentation/features/DiscardChangesDialog.vue";
import CollectionHeadersDialog from "@/view/presentation/features/CollectionHeadersDialog.vue";
import RequestEditor from "@/view/presentation/features/RequestEditor.vue";
import RequestTabs from "@/view/presentation/features/RequestTabs.vue";
import SaveRequestDialog from "@/view/presentation/features/SaveRequestDialog.vue";
import WorkspaceNavigator from "@/view/presentation/features/WorkspaceNavigator.vue";

const controller = useApplicationController();
const store = useApplicationStore();
const router = useRouter();
const { t } = useI18n();
const navigatorOpen = ref(false);
const saveDialogTab = ref<RequestTab | null>(null);
const discardDialogTab = ref<RequestTab | null>(null);
const collectionHeadersOpen = ref(false);
const {
  session,
  connection,
  workspaces,
  selectedWorkspaceId,
  rootNodes,
  selectedCollectionId,
  selectedCollection,
  collectionChildren,
  expandedCollectionIds,
  requestTabs,
  activeRequestTabId,
  busy,
  error,
} = storeToRefs(store);
const activeTab = computed(
  () =>
    requestTabs.value.find((tab) => tab.tabId === activeRequestTabId.value) ??
    null,
);
const visibleRequestTabs = computed(() =>
  requestTabs.value.filter(
    (tab) => tab.workspaceId === selectedWorkspaceId.value,
  ),
);
const errorMessage = computed(() => {
  if (error.value === null) {
    return null;
  }
  return error.value.code === null
    ? error.value.message
    : t(`errors.${error.value.code}`);
});

onMounted(async () => {
  window.addEventListener("beforeunload", protectUnsavedTabs);
  await controller.initializeWorkspace().catch(() => undefined);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", protectUnsavedTabs);
});

/** Warns before browser navigation would discard unsaved request tabs. */
function protectUnsavedTabs(event: BeforeUnloadEvent): void {
  if (requestTabs.value.some(isRequestTabDirty)) {
    event.preventDefault();
  }
}

/** Ends the current session and returns to the login view. */
async function logout(): Promise<void> {
  await controller.session.logout();
  await router.push("/login");
}

/** Toggles the mobile workspace navigator drawer. */
function toggleNavigator(): void {
  navigatorOpen.value = !navigatorOpen.value;
}

/** Closes the mobile workspace navigator drawer. */
function closeNavigator(): void {
  navigatorOpen.value = false;
}

/** Opens a temporary tab with an optional eventual collection destination. */
function createTemporaryRequest(
  parentCollectionId: string | null = null,
): void {
  controller.createTemporaryRequest(parentCollectionId);
  closeNavigator();
}

/** Selects a collection before opening a temporary request inside it. */
async function createRequestInCollection(collectionId: string): Promise<void> {
  if (selectedCollectionId.value !== collectionId) {
    await controller.selectCollection(collectionId);
  }
  createTemporaryRequest(collectionId);
}

/** Selects a request and reveals its tab after closing the mobile drawer. */
async function selectRequest(requestId: string): Promise<void> {
  await controller.selectRequest(requestId);
  closeNavigator();
}

/** Selects a collection and opens its common-header editor. */
async function editCollectionHeaders(collectionId: string): Promise<void> {
  await controller.selectCollection(collectionId);
  collectionHeadersOpen.value = true;
}

/** Saves a tab or asks for a temporary request destination. */
async function saveRequest(draft: RequestDraftInput): Promise<void> {
  const tab = activeTab.value;
  if (tab === null) {
    return;
  }
  controller.updateRequestDraft(tab.tabId, draft);
  if (tab.request === null) {
    saveDialogTab.value =
      requestTabs.value.find((candidate) => candidate.tabId === tab.tabId) ??
      null;
    return;
  }
  await controller.saveRequest(tab.tabId, draft);
}

/** Saves one temporary tab and closes its destination dialog. */
async function saveTemporaryRequest(
  name: string,
  parentCollectionId: string,
): Promise<void> {
  const tab = saveDialogTab.value;
  if (tab === null) {
    return;
  }
  await controller.saveTemporaryRequest(tab.tabId, name, parentCollectionId);
  saveDialogTab.value = null;
}

/** Executes the active tab without affecting other open request tabs. */
async function executeRequest(draft: RequestDraftInput): Promise<void> {
  const tab = activeTab.value;
  if (tab !== null) {
    await controller.executeRequest(tab.tabId, draft);
  }
}

/** Downloads exact response bytes without exposing the bearer token in a URL. */
async function downloadExecutionBody(executionId: string): Promise<void> {
  try {
    const body = await controller.downloadExecutionBody(executionId);
    const objectUrl = URL.createObjectURL(body);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `apinteract-response-${executionId}.bin`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  } catch {
    // The controller has already published a safe global application error.
  }
}

/** Saves the selected collection profile and closes its editor on success. */
async function saveCollectionHeaders(
  headers: readonly RequestField[],
): Promise<void> {
  const collection = selectedCollection.value;
  if (collection === null) {
    return;
  }
  await controller.updateCollectionHeaders(
    collection.collectionId,
    collection.revision,
    headers,
  );
  collectionHeadersOpen.value = false;
}

/** Closes a clean tab or opens discard confirmation for unsaved content. */
function requestTabClose(tabId: string): void {
  const tab = requestTabs.value.find((candidate) => candidate.tabId === tabId);
  if (tab === undefined) {
    return;
  }
  if (isRequestTabDirty(tab)) {
    discardDialogTab.value = tab;
  } else {
    controller.closeRequestTab(tabId);
  }
}

/** Discards and closes the tab selected by the confirmation dialog. */
function discardRequestTab(): void {
  const tab = discardDialogTab.value;
  if (tab !== null) {
    controller.closeRequestTab(tab.tabId);
  }
  discardDialogTab.value = null;
}
</script>

<template>
  <div class="application-shell">
    <AppHeader
      :display-name="session?.user.displayName ?? ''"
      :connected="connection === 'authenticated'"
      :navigator-open="navigatorOpen"
      @logout="logout"
      @toggle-navigator="toggleNavigator"
    />
    <div v-if="errorMessage" class="global-error" role="alert">
      {{ errorMessage }}
    </div>
    <div class="application-body">
      <WorkspaceNavigator
        id="workspace-navigator"
        :workspaces="workspaces"
        :selected-workspace-id="selectedWorkspaceId"
        :root-nodes="rootNodes"
        :selected-collection-id="selectedCollectionId"
        :collection-children="collectionChildren"
        :expanded-collection-ids="expandedCollectionIds"
        :selected-request-id="activeTab?.request?.requestId ?? null"
        :busy="busy"
        :mobile-open="navigatorOpen"
        @create-workspace="controller.createWorkspace($event)"
        @select-workspace="controller.selectWorkspace($event)"
        @create-collection="
          (name, parentCollectionId) =>
            controller.createCollection(name, parentCollectionId)
        "
        @select-collection="controller.selectCollection($event)"
        @toggle-collection="controller.toggleCollection($event)"
        @create-request="createRequestInCollection"
        @edit-collection-headers="editCollectionHeaders"
        @select-request="selectRequest"
        @dismiss="closeNavigator"
      />
      <button
        v-if="navigatorOpen"
        class="navigator-scrim"
        type="button"
        :aria-label="t('header.closeNavigator')"
        @click="closeNavigator"
      ></button>
      <div
        class="request-area"
        :inert="navigatorOpen"
        :aria-hidden="navigatorOpen ? 'true' : undefined"
      >
        <RequestTabs
          :tabs="visibleRequestTabs"
          :active-tab-id="activeRequestTabId"
          @activate="controller.activateRequestTab($event)"
          @close="requestTabClose"
          @create="createTemporaryRequest()"
        />
        <RequestEditor
          :request="activeTab?.request ?? null"
          :draft="activeTab?.draft ?? null"
          :execution="activeTab?.execution ?? null"
          :tab-id="activeTab?.tabId ?? null"
          :temporary="activeTab?.request === null"
          :inherited-headers="activeTab?.inheritedHeaders ?? []"
          :busy="activeTab?.busy ?? false"
          @change="
            activeTab && controller.updateRequestDraft(activeTab.tabId, $event)
          "
          @save="saveRequest"
          @execute="executeRequest"
          @download="downloadExecutionBody"
        />
      </div>
    </div>

    <SaveRequestDialog
      v-if="saveDialogTab"
      :tab="saveDialogTab"
      :root-nodes="rootNodes"
      :collection-children="collectionChildren"
      :busy="saveDialogTab.busy || busy"
      @close="saveDialogTab = null"
      @expand-collection="controller.loadCollectionChildren($event)"
      @save="saveTemporaryRequest"
    />
    <DiscardChangesDialog
      v-if="discardDialogTab"
      :request-name="
        discardDialogTab.draft.name.trim() || t('request.untitled')
      "
      @close="discardDialogTab = null"
      @discard="discardRequestTab"
    />
    <CollectionHeadersDialog
      v-if="collectionHeadersOpen && selectedCollection"
      :collection="selectedCollection"
      :busy="busy"
      @close="collectionHeadersOpen = false"
      @save="saveCollectionHeaders"
    />
  </div>
</template>
