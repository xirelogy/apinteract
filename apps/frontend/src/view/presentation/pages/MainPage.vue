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
  RequestView,
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
import RequestDuplicateDialog from "@/view/presentation/features/RequestDuplicateDialog.vue";
import RequestEditor from "@/view/presentation/features/RequestEditor.vue";
import RequestTabs from "@/view/presentation/features/RequestTabs.vue";
import ResourceDeleteDialog from "@/view/presentation/features/ResourceDeleteDialog.vue";
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
const requestDuplicateTarget = ref<{
  readonly requestId: string;
  readonly name: string;
} | null>(null);
const requestDeleteTarget = ref<{
  readonly request: RequestView;
  readonly hasUnsavedChanges: boolean;
} | null>(null);
const applicationBody = ref<HTMLElement | null>(null);
const navigatorWidth = ref(
  Math.min(304, Math.max(256, window.innerWidth * 0.2)),
);
const navigatorResizePointerId = ref<number | null>(null);
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
const displayedInheritedHeaders = computed(
  () =>
    activeTab.value?.viewingRevision?.request.inheritedHeaders ??
    activeTab.value?.inheritedHeaders ??
    [],
);
const displayedInheritedTarget = computed(
  () =>
    activeTab.value?.viewingRevision?.request.inheritedTarget ??
    activeTab.value?.inheritedTarget ??
    "",
);
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
const canDeleteWorkspace = computed(() => {
  const workspace = workspaces.value.find(
    (candidate) => candidate.workspaceId === selectedWorkspaceId.value,
  );
  return workspace?.role === "owner";
});
const navigatorPaneStyle = computed(() => ({
  "--navigator-width": `${navigatorWidth.value}px`,
}));
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

/** Constrains the desktop navigator while preserving useful request width. */
function setNavigatorWidth(width: number): void {
  const bodyWidth = applicationBody.value?.getBoundingClientRect().width;
  if (bodyWidth === undefined || bodyWidth <= 0) return;
  const maximumWidth = Math.max(224, Math.min(480, bodyWidth - 328));
  navigatorWidth.value = Math.min(Math.max(width, 224), maximumWidth);
}

/** Converts a physical pointer coordinate into logical navigator width. */
function setNavigatorWidthFromClientX(clientX: number): void {
  const body = applicationBody.value;
  const bounds = body?.getBoundingClientRect();
  if (body === null || bounds === undefined) return;
  const width =
    getComputedStyle(body).direction === "rtl"
      ? bounds.right - clientX
      : clientX - bounds.left;
  setNavigatorWidth(width);
}

/** Starts pointer-captured resizing from the desktop navigator separator. */
function startNavigatorResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  navigatorResizePointerId.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  setNavigatorWidthFromClientX(event.clientX);
}

/** Applies movement from the pointer currently resizing the navigator. */
function continueNavigatorResize(event: PointerEvent): void {
  if (navigatorResizePointerId.value !== event.pointerId) return;
  setNavigatorWidthFromClientX(event.clientX);
}

/** Releases pointer capture and ends desktop navigator resizing. */
function finishNavigatorResize(event: PointerEvent): void {
  if (navigatorResizePointerId.value !== event.pointerId) return;
  navigatorResizePointerId.value = null;
  const separator = event.currentTarget as HTMLElement;
  if (separator.hasPointerCapture?.(event.pointerId)) {
    separator.releasePointerCapture(event.pointerId);
  }
}

/** Ends navigator resizing when the browser revokes pointer capture. */
function cancelNavigatorResize(): void {
  navigatorResizePointerId.value = null;
}

/** Resizes the navigator by keyboard in the document's logical direction. */
function resizeNavigatorByKeyboard(event: KeyboardEvent): void {
  const body = applicationBody.value;
  if (body === null) return;
  const rtl = getComputedStyle(body).direction === "rtl";
  let nextWidth: number;
  if (event.key === "ArrowLeft") {
    nextWidth = navigatorWidth.value + (rtl ? 24 : -24);
  } else if (event.key === "ArrowRight") {
    nextWidth = navigatorWidth.value + (rtl ? -24 : 24);
  } else if (event.key === "Home") {
    nextWidth = 0;
  } else if (event.key === "End") {
    nextWidth = Number.POSITIVE_INFINITY;
  } else {
    return;
  }
  event.preventDefault();
  setNavigatorWidth(nextWidth);
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

/** Returns the open tab for one saved request when it is already loaded. */
function requestTabFor(requestId: string): RequestTab | undefined {
  return requestTabs.value.find((tab) => tab.request?.requestId === requestId);
}

/** Duplicates immediately unless unsaved edits require an explicit warning. */
async function duplicateRequest(
  requestId: string,
  name: string,
): Promise<void> {
  closeNavigator();
  const tab = requestTabFor(requestId);
  const target = { requestId, name };
  if (tab !== undefined && isRequestTabDirty(tab)) {
    requestDuplicateTarget.value = target;
    return;
  }
  await performRequestDuplication(target);
}

/** Creates and opens the localized saved copy selected by the user. */
async function performRequestDuplication(target: {
  readonly requestId: string;
  readonly name: string;
}): Promise<void> {
  await controller.duplicateRequest(
    target.requestId,
    localizedRequestCopyName(target.name),
  );
  requestDuplicateTarget.value = null;
}

/** Builds a localized copy name within the persisted 200-character limit. */
function localizedRequestCopyName(name: string): string {
  const suffix = t("request.copySuffix");
  const prefixLimit = 200 - suffix.length;
  let prefix = "";
  for (const character of name) {
    if (prefix.length + character.length > prefixLimit) break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

/** Continues a saved-version duplication after its unsaved-edit warning. */
async function confirmRequestDuplication(): Promise<void> {
  const target = requestDuplicateTarget.value;
  if (target !== null) await performRequestDuplication(target);
}

/** Loads immutable deletion metadata before displaying styled confirmation. */
async function requestRequestDeletion(requestId: string): Promise<void> {
  closeNavigator();
  const tab = requestTabFor(requestId);
  const request = tab?.request ?? (await controller.loadRequest(requestId));
  requestDeleteTarget.value = {
    request,
    hasUnsavedChanges: tab !== undefined && isRequestTabDirty(tab),
  };
}

/** Deletes the confirmed request and closes the confirmation after success. */
async function confirmRequestDeletion(): Promise<void> {
  const target = requestDeleteTarget.value;
  if (target === null) return;
  await controller.deleteRequest(target.request);
  requestDeleteTarget.value = null;
}

/** Switches the active request tab to one revision or its current draft. */
function selectActiveRevision(revisionId: string | null): void {
  if (activeTab.value !== null) {
    void controller.selectRequestRevision(activeTab.value.tabId, revisionId);
  }
}

/** Names one immutable revision belonging to the active request tab. */
function nameActiveRevision(revisionId: string, name: string | null): void {
  if (activeTab.value !== null) {
    void controller.nameRequestRevision(
      activeTab.value.tabId,
      revisionId,
      name,
    );
  }
}

/** Restores one immutable revision into the active mutable draft. */
function restoreActiveRevision(revisionId: string): void {
  if (activeTab.value !== null) {
    void controller.restoreRequestRevision(activeTab.value.tabId, revisionId);
  }
}

/** Executes one immutable revision from the active request tab. */
function executeActiveRevision(revisionId: string): void {
  if (activeTab.value !== null) {
    void controller.executeRequestRevision(activeTab.value.tabId, revisionId);
  }
}

/** Releases a request deletion target when its controlled dialog closes. */
function setRequestDeleteDialogOpen(open: boolean): void {
  if (!open) requestDeleteTarget.value = null;
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
  pathPrefix: string,
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
    pathPrefix,
    headers,
    profile.revision,
    variables,
  );
  collectionPropertiesOpen.value = false;
}

/** Saves every editable property for the selected workspace. */
async function saveWorkspaceProperties(
  name: string,
  baseUrl: string,
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
    baseUrl,
    headers,
    profile.revision,
    variables,
  );
  workspacePropertiesOpen.value = false;
}

/** Deletes the selected collection and closes its properties after refresh. */
async function deleteCollection(
  collectionId: string,
  revision: number,
): Promise<void> {
  await controller.deleteCollection(collectionId, revision);
  collectionPropertiesOpen.value = false;
}

/** Deletes the selected owner-managed workspace and closes its properties. */
async function deleteWorkspace(
  workspaceId: string,
  revision: number,
): Promise<void> {
  await controller.deleteWorkspace(workspaceId, revision);
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
    <div
      ref="applicationBody"
      class="application-body"
      :style="navigatorPaneStyle"
      :data-resizing-navigator="
        navigatorResizePointerId === null ? undefined : ''
      "
    >
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
        :can-edit="canEditWorkspace"
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
        @duplicate-request="duplicateRequest"
        @delete-request="requestRequestDeletion"
        @dismiss="closeNavigator"
      />
      <div
        class="navigator-pane-separator"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-controls="workspace-navigator"
        :aria-label="t('workspace.resizeNavigation')"
        aria-valuemin="224"
        aria-valuemax="480"
        :aria-valuenow="Math.round(navigatorWidth)"
        @pointerdown="startNavigatorResize"
        @pointermove="continueNavigatorResize"
        @pointerup="finishNavigatorResize"
        @pointercancel="finishNavigatorResize"
        @lostpointercapture="cancelNavigatorResize"
        @keydown="resizeNavigatorByKeyboard"
      ></div>
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
          :inherited-target="displayedInheritedTarget"
          :inherited-headers="displayedInheritedHeaders"
          :request-variable-profile="requestVariableProfile"
          :variable-previews="variablePreviews"
          :preview-context-key="variablePreviewContextKey"
          :busy="(activeTab?.busy ?? false) || busy"
          :can-edit="canEditWorkspace"
          :revisions="activeTab?.revisions ?? []"
          :viewing-revision="activeTab?.viewingRevision ?? null"
          @change="
            activeTab && controller.updateRequestDraft(activeTab.tabId, $event)
          "
          @save="saveRequest"
          @execute="executeRequest"
          @preview="controller.previewVariables($event)"
          @load-variables="editRequestVariables"
          @save-variables="saveRequestVariables"
          @load-revisions="
            activeTab && controller.loadRequestRevisions(activeTab.tabId)
          "
          @select-revision="selectActiveRevision"
          @name-revision="nameActiveRevision"
          @restore-revision="restoreActiveRevision"
          @execute-revision="executeActiveRevision"
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
    <RequestDuplicateDialog
      v-if="requestDuplicateTarget"
      :request-name="requestDuplicateTarget.name"
      :busy="busy"
      @close="requestDuplicateTarget = null"
      @confirm="confirmRequestDuplication"
    />
    <ResourceDeleteDialog
      v-if="requestDeleteTarget"
      :open="true"
      title-id="request-delete-dialog-title"
      :title="t('request.deleteTitle')"
      :message="
        t('request.deleteMessage', { name: requestDeleteTarget.request.name })
      "
      :additional-message="
        t(
          requestDeleteTarget.hasUnsavedChanges
            ? 'request.deleteUnsavedChanges'
            : 'request.deleteHistoryRetained',
        )
      "
      :confirm-label="t('request.deleteAction')"
      :busy="busy"
      @update:open="setRequestDeleteDialogOpen"
      @confirm="confirmRequestDeletion"
    />
    <CollectionPropertiesDialog
      v-if="collectionProperties"
      :collection="collectionProperties.collection"
      :variable-profile="collectionProperties.variableProfile"
      :can-edit="canEditWorkspace"
      :busy="busy"
      @close="collectionPropertiesOpen = false"
      @save="saveCollectionProperties"
      @delete="deleteCollection"
    />
    <WorkspacePropertiesDialog
      v-if="workspaceProperties"
      :workspace="workspaceProperties.workspace"
      :variable-profile="workspaceProperties.variableProfile"
      :can-edit="canEditWorkspace"
      :can-delete="canDeleteWorkspace"
      :busy="busy"
      @close="workspacePropertiesOpen = false"
      @save="saveWorkspaceProperties"
      @delete="deleteWorkspace"
    />
  </div>
</template>
