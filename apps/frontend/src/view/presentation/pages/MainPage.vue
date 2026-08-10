<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import { useApplicationStore } from "@/control/state/application-store";
import type {
  EnvironmentVariableWrite,
  RequestField,
  VariableWrite,
} from "@/model/contracts/backend";
import {
  isRequestTabDirty,
  type RequestDraftInput,
  type RequestTab,
} from "@/model/domain/application";
import AppHeader from "@/view/presentation/layout/AppHeader.vue";
import DiscardChangesDialog from "@/view/presentation/features/DiscardChangesDialog.vue";
import CollectionPropertiesDialog from "@/view/presentation/features/CollectionPropertiesDialog.vue";
import EnvironmentManager from "@/view/presentation/features/EnvironmentManager.vue";
import RequestEditor from "@/view/presentation/features/RequestEditor.vue";
import RequestTabs from "@/view/presentation/features/RequestTabs.vue";
import SaveRequestDialog from "@/view/presentation/features/SaveRequestDialog.vue";
import WorkspaceNavigator from "@/view/presentation/features/WorkspaceNavigator.vue";
import WorkspacePropertiesDialog from "@/view/presentation/features/WorkspacePropertiesDialog.vue";

const controller = useApplicationController();
const store = useApplicationStore();
const router = useRouter();
const { t } = useI18n();
const navigatorOpen = ref(false);
const saveDialogTab = ref<RequestTab | null>(null);
const discardDialogTab = ref<RequestTab | null>(null);
const collectionPropertiesOpen = ref(false);
const workspacePropertiesOpen = ref(false);
const environmentManager = ref<InstanceType<typeof EnvironmentManager> | null>(
  null,
);
const {
  session,
  workspaces,
  selectedWorkspaceId,
  selectedWorkspace,
  environments,
  selectedEnvironmentId,
  selectedEnvironment,
  selectedVariableProfile,
  variablePreviews,
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
const collectionProperties = computed(() => {
  const collection = selectedCollection.value;
  const variableProfile = selectedVariableProfile.value;
  return collectionPropertiesOpen.value &&
    collection !== null &&
    variableProfile?.scopeKind === "collection" &&
    variableProfile.scopeId === collection.collectionId
    ? { collection, variableProfile }
    : null;
});
const workspaceProperties = computed(() => {
  const workspace = selectedWorkspace.value;
  const variableProfile = selectedVariableProfile.value;
  return workspacePropertiesOpen.value &&
    workspace !== null &&
    variableProfile?.scopeKind === "workspace" &&
    variableProfile.scopeId === workspace.workspaceId
    ? { workspace, variableProfile }
    : null;
});
const requestVariableProfile = computed(() => {
  const requestId = activeTab.value?.request?.requestId;
  const profile = selectedVariableProfile.value;
  return requestId !== undefined &&
    profile?.scopeKind === "request" &&
    profile.scopeId === requestId
    ? profile
    : null;
});
const variablePreviewContextKey = computed(() =>
  [
    selectedWorkspaceId.value ?? "",
    selectedEnvironmentId.value ?? "",
    activeTab.value?.request?.requestId ?? "",
    activeTab.value?.request?.parentCollectionId ??
      activeTab.value?.pendingParentCollectionId ??
      "",
  ].join(":"),
);
const canEditWorkspace = computed(() => {
  const workspace = workspaces.value.find(
    (candidate) => candidate.workspaceId === selectedWorkspaceId.value,
  );
  return workspace?.role === "owner" || workspace?.role === "editor";
});
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

/** Loads a collection and its redacted variables before opening properties. */
async function editCollectionProperties(collectionId: string): Promise<void> {
  await controller.selectCollection(collectionId);
  await controller.loadVariableProfile("collection", collectionId);
  collectionPropertiesOpen.value = true;
}

/** Loads workspace headers and variables before opening unified properties. */
async function editWorkspaceProperties(workspaceId: string): Promise<void> {
  await controller.loadWorkspace(workspaceId);
  await controller.loadVariableProfile("workspace", workspaceId);
  workspacePropertiesOpen.value = true;
}

/** Opens persisted variables for the active saved request. */
async function editRequestVariables(): Promise<void> {
  const requestId = activeTab.value?.request?.requestId;
  if (requestId !== undefined) {
    await controller.loadVariableProfile("request", requestId);
  }
}

/** Saves persisted variables owned by the active saved request. */
async function saveRequestVariables(
  variables: readonly VariableWrite[],
): Promise<void> {
  const profile = requestVariableProfile.value;
  if (profile !== null) {
    await controller.updateVariableProfile(
      "request",
      profile.scopeId,
      profile.revision,
      variables,
    );
  }
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

/** Saves every editable property for the selected collection. */
async function saveCollectionProperties(
  name: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): Promise<void> {
  const collection = selectedCollection.value;
  const profile = selectedVariableProfile.value;
  if (
    collection === null ||
    profile === null ||
    profile.scopeKind !== "collection" ||
    profile.scopeId !== collection.collectionId
  ) {
    return;
  }
  await controller.updateCollectionProperties(
    collection.collectionId,
    collection.revision,
    name,
    headers,
    profile.revision,
    variables,
  );
  collectionPropertiesOpen.value = false;
}

/** Saves every editable property for the selected workspace. */
async function saveWorkspaceProperties(
  name: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): Promise<void> {
  const workspace = selectedWorkspace.value;
  const profile = selectedVariableProfile.value;
  if (
    workspace === null ||
    profile === null ||
    profile.scopeKind !== "workspace" ||
    profile.scopeId !== workspace.workspaceId
  ) {
    return;
  }
  await controller.updateWorkspaceProperties(
    workspace.workspaceId,
    workspace.revision,
    name,
    headers,
    profile.revision,
    variables,
  );
  workspacePropertiesOpen.value = false;
}

/** Creates an environment and closes its editor after summaries refresh. */
async function createEnvironment(
  name: string,
  variables: readonly EnvironmentVariableWrite[],
): Promise<void> {
  await controller.createEnvironment(name, variables);
  environmentManager.value?.finishMutation();
}

/** Updates an environment and closes its editor after summaries refresh. */
async function updateEnvironment(
  environmentId: string,
  revision: number,
  name: string,
  variables: readonly EnvironmentVariableWrite[],
): Promise<void> {
  await controller.updateEnvironment(environmentId, revision, name, variables);
  environmentManager.value?.finishMutation();
}

/** Deletes an environment and closes its editor after summaries refresh. */
async function deleteEnvironment(
  environmentId: string,
  revision: number,
): Promise<void> {
  await controller.deleteEnvironment(environmentId, revision);
  environmentManager.value?.finishMutation();
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
      :username="session?.user.username ?? ''"
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
        @reorder-tree="
          (parentCollectionId, orderedNodeIds, expectedOrderRevision) =>
            controller.reorderTreeNodes(
              parentCollectionId,
              orderedNodeIds,
              expectedOrderRevision,
            )
        "
        @move-tree="
          (nodeId, targetNodeId, placement, expectedSourceOrderRevision) =>
            controller.moveTreeNode(
              nodeId,
              targetNodeId,
              placement,
              expectedSourceOrderRevision,
            )
        "
        @create-request="createRequestInCollection"
        @edit-collection-properties="editCollectionProperties"
        @edit-workspace-properties="editWorkspaceProperties"
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
        <EnvironmentManager
          v-if="selectedWorkspaceId"
          ref="environmentManager"
          :environments="environments"
          :selected-environment-id="selectedEnvironmentId"
          :environment="selectedEnvironment"
          :can-edit="canEditWorkspace"
          :busy="busy"
          @select="controller.selectEnvironment($event)"
          @load="controller.loadEnvironment($event)"
          @create="createEnvironment"
          @save="updateEnvironment"
          @delete="deleteEnvironment"
        />
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
          :request-variable-profile="requestVariableProfile"
          :variable-previews="variablePreviews"
          :preview-context-key="variablePreviewContextKey"
          :busy="(activeTab?.busy ?? false) || busy"
          :can-edit="canEditWorkspace"
          @change="
            activeTab && controller.updateRequestDraft(activeTab.tabId, $event)
          "
          @save="saveRequest"
          @execute="executeRequest"
          @preview="controller.previewVariables($event)"
          @load-variables="editRequestVariables"
          @save-variables="saveRequestVariables"
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
    <CollectionPropertiesDialog
      v-if="collectionProperties"
      :collection="collectionProperties.collection"
      :variable-profile="collectionProperties.variableProfile"
      :can-edit="canEditWorkspace"
      :busy="busy"
      @close="collectionPropertiesOpen = false"
      @save="saveCollectionProperties"
    />
    <WorkspacePropertiesDialog
      v-if="workspaceProperties"
      :workspace="workspaceProperties.workspace"
      :variable-profile="workspaceProperties.variableProfile"
      :can-edit="canEditWorkspace"
      :busy="busy"
      @close="workspacePropertiesOpen = false"
      @save="saveWorkspaceProperties"
    />
  </div>
</template>
