<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import { useApplicationStore } from "@/control/state/application-store";
import type {
  ExecutionView,
  RequestAttachment,
  RequestField,
  RequestView,
  VariableWrite,
} from "@/model/contracts/backend";
import {
  isResourceEditorTabDirty,
  isRequestTabDirty,
  isWorkbenchTabDirty,
  workbenchTabId,
  workbenchTabName,
  workbenchTabWorkspaceId,
  type ResourceEditorTab,
  type RequestDraftInput,
  type RequestTab,
  type WorkbenchTab,
} from "@/model/domain/application";
import AppHeader from "@/view/presentation/layout/AppHeader.vue";
import CloseTabsDialog from "@/view/presentation/features/CloseTabsDialog.vue";
import DiscardChangesDialog from "@/view/presentation/features/DiscardChangesDialog.vue";
import CollectionPropertiesDialog from "@/view/presentation/features/CollectionPropertiesDialog.vue";
import EnvironmentManager from "@/view/presentation/features/EnvironmentManager.vue";
import ImportDialog from "@/view/presentation/features/ImportDialog.vue";
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
const discardResourceTab = ref<ResourceEditorTab | null>(null);
const pendingBulkTabClose = ref<{
  readonly tabIds: readonly string[];
  readonly dirtyTabNames: readonly string[];
  readonly runningCount: number;
} | null>(null);
const importDialogOpen = ref(false);
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
const {
  session,
  workspaces,
  selectedWorkspaceId,
  environments,
  selectedEnvironmentId,
  variablePreviews,
  rootNodes,
  selectedCollectionId,
  selectedCollection,
  collectionChildren,
  expandedCollectionIds,
  requestTabs,
  activeRequestTabId,
  resourceTabs,
  workbenchTabOrder,
  activeWorkbenchTabId,
  busy,
  error,
} = storeToRefs(store);
const activeTab = computed(
  () =>
    requestTabs.value.find(
      (tab) =>
        tab.tabId === activeRequestTabId.value &&
        (activeWorkbenchTabId.value === null ||
          tab.tabId === activeWorkbenchTabId.value),
    ) ?? null,
);
const workbenchTabs = computed<WorkbenchTab[]>(() => {
  const byId = new Map<string, WorkbenchTab>([
    ...requestTabs.value.map((requestTab): [string, WorkbenchTab] => [
      requestTab.tabId,
      { kind: "request", requestTab },
    ]),
    ...resourceTabs.value.map((resourceTab): [string, WorkbenchTab] => [
      resourceTab.tabId,
      resourceTab,
    ]),
  ]);
  const ordered = workbenchTabOrder.value.flatMap((tabId) => {
    const tab = byId.get(tabId);
    return tab === undefined ? [] : [tab];
  });
  const orderedIds = new Set(ordered.map(workbenchTabId));
  return [
    ...ordered,
    ...[...byId.values()].filter((tab) => !orderedIds.has(workbenchTabId(tab))),
  ];
});
const activeWorkbenchTitle = computed(() => {
  const tab = workbenchTabs.value.find(
    (candidate) => workbenchTabId(candidate) === activeWorkbenchTabId.value,
  );
  return tab === undefined
    ? null
    : workbenchTabName(tab, {
        untitledRequest: t("request.untitled"),
        createEnvironment: t("environment.create"),
      });
});
watch(
  activeWorkbenchTitle,
  (title) => {
    document.title =
      title === null || title === "" ? "APInteract" : `${title} · APInteract`;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  document.title = "APInteract";
});
const activeResourceTab = computed(
  () =>
    resourceTabs.value.find(
      (tab) => tab.tabId === activeWorkbenchTabId.value,
    ) ?? null,
);
const displayedExecution = computed<ExecutionView | null>(() => {
  const tab = activeTab.value;
  if (
    tab?.execution !== null &&
    tab?.execution !== undefined &&
    (tab.request === null ||
      tab.selectedExchangeId === tab.execution.executionId)
  ) {
    return tab.execution;
  }
  if (tab?.selectedExchange !== null && tab?.selectedExchange !== undefined) {
    return tab.selectedExchange.execution;
  }
  if (tab?.viewingRevision !== null && tab?.viewingRevision !== undefined) {
    return null;
  }
  const capture = tab?.capturedExchange;
  if (capture === null || capture === undefined) return null;
  const timestamp =
    capture.recordedAt ?? capture.importedAt ?? "1970-01-01T00:00:00.000Z";
  return {
    executionId:
      capture.capturedExchangeId ?? tab?.tabId ?? "captured-response",
    state: "completed",
    status: capture.status,
    headers: capture.headers,
    bodyComplete: capture.bodyComplete,
    bodyBytes: capture.bodyBytes,
    ...(capture.body !== "" || capture.bodyBytes === 0
      ? { bodyPreview: capture.body }
      : {}),
    createdAt: timestamp,
    completedAt: timestamp,
    scriptLogs: [],
    scriptTests: [],
  };
});
const displayingCapturedResponse = computed(() => {
  const tab = activeTab.value;
  if (tab === null) return false;
  const selectedSummary = (tab.exchangeSummaries ?? []).find(
    (summary) => summary.exchangeId === tab.selectedExchangeId,
  );
  if (selectedSummary !== undefined) return selectedSummary.kind === "capture";
  return (
    tab.execution === null &&
    tab.capturedExchange !== null &&
    tab.capturedExchange !== undefined &&
    tab.viewingRevision === null
  );
});
const visibleWorkbenchTabs = computed(() =>
  workbenchTabs.value.filter(
    (tab) => workbenchTabWorkspaceId(tab) === selectedWorkspaceId.value,
  ),
);
const requestVariableProfile = computed(() => {
  return activeTab.value?.variableProfile ?? null;
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
    activeResourceTab.value?.kind ?? "request-editor",
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
  await controller.initializeWorkspace().catch(() => undefined);
});

/** Ends the current session and returns to the login view. */
async function logout(): Promise<void> {
  await controller.logout();
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

/** Opens the source-neutral import workflow for the current workspace context. */
function openImportDialog(): void {
  importDialogOpen.value = true;
  closeNavigator();
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

/** Displays one persisted request-response exchange in the active response pane. */
function selectActiveExchange(exchangeId: string): void {
  if (activeTab.value !== null) {
    void controller.selectRequestExchange(activeTab.value.tabId, exchangeId);
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
  await controller.openCollectionPropertiesTab(collectionId);
}

/** Loads workspace headers and variables before opening unified properties. */
async function editWorkspaceProperties(workspaceId: string): Promise<void> {
  await controller.openWorkspacePropertiesTab(workspaceId);
}

/** Opens inherited and local variables for the active request draft. */
async function editRequestVariables(): Promise<void> {
  const tab = activeTab.value;
  if (tab === null) return;
  if (tab.request === null) {
    await controller.loadTemporaryVariableProfile(tab.tabId);
    return;
  }
  await controller.loadVariableProfile("request", tab.request.requestId);
}

/** Keeps request-variable edits in the active tab until the request is saved. */
function updateActiveRequestVariables(
  variables: readonly VariableWrite[],
): void {
  if (activeTab.value !== null) {
    controller.updateRequestVariableDraft(activeTab.value.tabId, variables);
  }
}

/** Applies editor changes to the currently active request tab. */
function updateActiveRequestDraft(draft: RequestDraftInput): void {
  if (activeTab.value !== null) {
    controller.updateRequestDraft(activeTab.value.tabId, draft);
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

/** Uploads one file into the active request tab's workspace. */
async function uploadActiveRequestAttachment(
  file: File,
): Promise<RequestAttachment> {
  const tab = activeTab.value;
  if (tab === null) throw new Error("An active request is required");
  return controller.uploadRequestAttachment(tab.workspaceId, file);
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
  tabId: string,
  name: string,
  description: string,
  notes: string,
  pathPrefix: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): Promise<void> {
  controller.updateCollectionPropertiesDraft(tabId, {
    name,
    description,
    notes,
    pathPrefix,
    headers,
    variables,
  });
  await controller.saveCollectionPropertiesTab(tabId);
}

/** Saves every editable property for the selected workspace. */
async function saveWorkspaceProperties(
  tabId: string,
  name: string,
  description: string,
  notes: string,
  baseUrl: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): Promise<void> {
  controller.updateWorkspacePropertiesDraft(tabId, {
    name,
    description,
    notes,
    baseUrl,
    headers,
    variables,
  });
  await controller.saveWorkspacePropertiesTab(tabId);
}

/** Saves the active workspace editor without relying on template narrowing. */
function saveActiveWorkspaceProperties(
  name: string,
  description: string,
  notes: string,
  baseUrl: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): void {
  const tab = activeResourceTab.value;
  if (tab?.kind === "workspace") {
    void saveWorkspaceProperties(
      tab.tabId,
      name,
      description,
      notes,
      baseUrl,
      headers,
      variables,
    );
  }
}

/** Saves the active collection editor without relying on template narrowing. */
function saveActiveCollectionProperties(
  name: string,
  description: string,
  notes: string,
  pathPrefix: string,
  headers: readonly RequestField[],
  variables: readonly VariableWrite[],
): void {
  const tab = activeResourceTab.value;
  if (tab?.kind === "collection") {
    void saveCollectionProperties(
      tab.tabId,
      name,
      description,
      notes,
      pathPrefix,
      headers,
      variables,
    );
  }
}

/** Deletes the selected collection and closes its properties after refresh. */
async function deleteCollection(
  collectionId: string,
  revision: number,
): Promise<void> {
  await controller.deleteCollection(collectionId, revision);
}

/** Deletes the selected owner-managed workspace and closes its properties. */
async function deleteWorkspace(
  workspaceId: string,
  revision: number,
): Promise<void> {
  await controller.deleteWorkspace(workspaceId, revision);
}

/** Deletes an environment and closes its editor after summaries refresh. */
async function deleteEnvironment(
  environmentId: string,
  revision: number,
): Promise<void> {
  await controller.deleteEnvironment(environmentId, revision);
}

/** Opens a saved or new environment as a first-class workbench tab. */
function openEnvironmentEditor(environmentId: string | null): void {
  void controller.openEnvironmentTab(environmentId);
}

/** Saves draft changes owned by one environment workbench tab. */
function saveEnvironmentEditor(tabId: string): void {
  void controller.saveEnvironmentTab(tabId);
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

/** Closes any clean workbench tab or confirms discarding its local draft. */
function workbenchTabClose(tabId: string): void {
  const workbenchTab = workbenchTabs.value.find(
    (tab) => workbenchTabId(tab) === tabId,
  );
  if (workbenchTab === undefined) return;
  if (workbenchTab.kind === "request") {
    requestTabClose(tabId);
    return;
  }
  if (isResourceEditorTabDirty(workbenchTab)) {
    discardResourceTab.value = workbenchTab;
  } else {
    controller.closeResourceTab(tabId);
  }
}

/** Returns a localized, non-empty label for aggregate tab-close feedback. */
function workbenchTabDisplayName(tab: WorkbenchTab): string {
  const name =
    tab.kind === "request" ? tab.requestTab.draft.name : tab.draft.name;
  if (name.trim() !== "") return name.trim();
  if (tab.kind === "request") return t("request.untitled");
  if (tab.kind === "workspace") return t("workspace.label");
  if (tab.kind === "collection") return t("collection.label");
  return t("environment.create");
}

/** Reports whether closing a request tab leaves an active execution running. */
function hasActiveExecution(tab: WorkbenchTab): boolean {
  return (
    tab.kind === "request" &&
    (tab.requestTab.execution?.state === "created" ||
      tab.requestTab.execution?.state === "running")
  );
}

/** Closes safe targets immediately or requests one aggregate confirmation. */
function requestBulkTabClose(tabs: readonly WorkbenchTab[]): void {
  if (tabs.length === 0) return;
  const dirtyTabNames = tabs
    .filter(isWorkbenchTabDirty)
    .map(workbenchTabDisplayName);
  const runningCount = tabs.filter(hasActiveExecution).length;
  const tabIds = tabs.map(workbenchTabId);
  if (dirtyTabNames.length === 0 && runningCount === 0) {
    controller.closeWorkbenchTabs(tabIds);
    return;
  }
  pendingBulkTabClose.value = { tabIds, dirtyTabNames, runningCount };
}

/** Requests closure of every visible tab except the active menu target. */
function closeOtherWorkbenchTabs(tabId: string): void {
  requestBulkTabClose(
    visibleWorkbenchTabs.value.filter((tab) => workbenchTabId(tab) !== tabId),
  );
}

/** Requests closure of every workbench tab visible in the current workspace. */
function closeAllWorkbenchTabs(): void {
  requestBulkTabClose(visibleWorkbenchTabs.value);
}

/** Confirms the pending aggregate close against its original tab identifiers. */
function confirmBulkTabClose(): void {
  const pending = pendingBulkTabClose.value;
  if (pending !== null) controller.closeWorkbenchTabs(pending.tabIds);
  pendingBulkTabClose.value = null;
}

/** Discards and closes the tab selected by the confirmation dialog. */
function discardRequestTab(): void {
  const tab = discardDialogTab.value;
  if (tab !== null) {
    controller.closeRequestTab(tab.tabId);
  }
  discardDialogTab.value = null;
}

/** Discards and closes the resource editor selected for confirmation. */
function discardActiveResourceTab(): void {
  if (discardResourceTab.value !== null) {
    controller.closeResourceTab(discardResourceTab.value.tabId);
  }
  discardResourceTab.value = null;
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
        @import="openImportDialog"
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
        <div
          v-if="selectedWorkspaceId === null"
          class="empty-workbench workspace-empty-state"
        >
          <h1>{{ t("workspace.startTitle") }}</h1>
          <p>{{ t("workspace.startDescription") }}</p>
        </div>
        <template v-else>
          <EnvironmentManager
            :environments="environments"
            :selected-environment-id="selectedEnvironmentId"
            :editor-tab="null"
            :can-edit="canEditWorkspace"
            :busy="busy"
            @select="controller.selectEnvironment($event)"
            @open-editor="openEnvironmentEditor"
          />
          <RequestTabs
            :tabs="visibleWorkbenchTabs"
            :active-tab-id="activeWorkbenchTabId"
            @activate="controller.activateWorkbenchTab($event)"
            @close="workbenchTabClose"
            @close-others="closeOtherWorkbenchTabs"
            @close-all="closeAllWorkbenchTabs"
            @create="createTemporaryRequest()"
          />
          <WorkspacePropertiesDialog
            v-if="activeResourceTab?.kind === 'workspace'"
            :key="`${activeResourceTab.tabId}:${activeResourceTab.workspace.revision}:${activeResourceTab.variableProfile.revision}`"
            :workspace="activeResourceTab.workspace"
            :draft="activeResourceTab.draft"
            :variable-profile="activeResourceTab.variableProfile"
            :variable-previews="variablePreviews"
            :can-edit="canEditWorkspace"
            :can-delete="canDeleteWorkspace"
            :busy="busy"
            :recovery-warning="activeResourceTab.omittedSecretValues ?? false"
            @change="
              controller.updateWorkspacePropertiesDraft(
                activeResourceTab.tabId,
                $event,
              )
            "
            @preview="
              controller.previewVariables($event, {
                parentCollectionId: null,
                requestId: null,
              })
            "
            @save="saveActiveWorkspaceProperties"
            @delete="deleteWorkspace"
          />
          <CollectionPropertiesDialog
            v-else-if="activeResourceTab?.kind === 'collection'"
            :key="`${activeResourceTab.tabId}:${activeResourceTab.collection.revision}:${activeResourceTab.variableProfile.revision}`"
            :collection="activeResourceTab.collection"
            :draft="activeResourceTab.draft"
            :variable-profile="activeResourceTab.variableProfile"
            :variable-previews="variablePreviews"
            :can-edit="canEditWorkspace"
            :busy="busy"
            :recovery-warning="activeResourceTab.omittedSecretValues ?? false"
            @change="
              controller.updateCollectionPropertiesDraft(
                activeResourceTab.tabId,
                $event,
              )
            "
            @preview="
              controller.previewVariables($event, {
                parentCollectionId: activeResourceTab.collection.collectionId,
                requestId: null,
              })
            "
            @save="saveActiveCollectionProperties"
            @delete="deleteCollection"
          />
          <EnvironmentManager
            v-else-if="activeResourceTab?.kind === 'environment'"
            :key="`${activeResourceTab.tabId}:${activeResourceTab.environment?.revision ?? 'new'}`"
            :environments="environments"
            :selected-environment-id="selectedEnvironmentId"
            :editor-tab="activeResourceTab"
            :show-toolbar="false"
            :can-edit="canEditWorkspace"
            :busy="busy"
            @change="
              (tabId, draft) => controller.updateEnvironmentDraft(tabId, draft)
            "
            @save-editor="saveEnvironmentEditor"
            @delete="deleteEnvironment"
          />
          <RequestEditor
            v-else
            :request="activeTab?.request ?? null"
            :draft="activeTab?.draft ?? null"
            :execution="displayedExecution"
            :captured-response="displayingCapturedResponse"
            :exchange-summaries="activeTab?.exchangeSummaries ?? []"
            :selected-exchange-id="activeTab?.selectedExchangeId ?? null"
            :tab-id="activeTab?.tabId ?? null"
            :temporary="activeTab?.request === null"
            :inherited-target="displayedInheritedTarget"
            :inherited-headers="displayedInheritedHeaders"
            :request-variable-profile="requestVariableProfile"
            :request-variable-draft="activeTab?.variableDraft ?? null"
            :variable-previews="variablePreviews"
            :preview-context-key="variablePreviewContextKey"
            :busy="(activeTab?.busy ?? false) || busy"
            :can-edit="canEditWorkspace"
            :revisions="activeTab?.revisions ?? []"
            :viewing-revision="activeTab?.viewingRevision ?? null"
            :recovery-warnings="activeTab?.recoveryWarnings ?? []"
            :upload-attachment="uploadActiveRequestAttachment"
            @change="updateActiveRequestDraft"
            @save="saveRequest"
            @execute="executeRequest"
            @preview="controller.previewVariables($event)"
            @load-variables="editRequestVariables"
            @change-variables="updateActiveRequestVariables"
            @load-revisions="
              activeTab && controller.loadRequestRevisions(activeTab.tabId)
            "
            @select-revision="selectActiveRevision"
            @name-revision="nameActiveRevision"
            @restore-revision="restoreActiveRevision"
            @execute-revision="executeActiveRevision"
            @select-exchange="selectActiveExchange"
            @download="downloadExecutionBody"
          />
        </template>
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
    <ImportDialog
      v-if="importDialogOpen && selectedWorkspaceId !== null"
      :selected-collection-id="selectedCollectionId"
      :selected-collection-name="selectedCollection?.name ?? null"
      :busy="busy"
      :list-providers="() => controller.listImportProviders()"
      :preview-import="
        (providerId, sourceName, sourceText) =>
          controller.previewImport(providerId, sourceName, sourceText)
      "
      :apply-import="(options) => controller.applyImport(options)"
      :open-temporary="
        (plan, request) =>
          controller.createImportedTemporaryRequest(plan, request)
      "
      @close="importDialogOpen = false"
    />
    <DiscardChangesDialog
      v-if="discardDialogTab"
      :request-name="
        discardDialogTab.draft.name.trim() || t('request.untitled')
      "
      @close="discardDialogTab = null"
      @discard="discardRequestTab"
    />
    <DiscardChangesDialog
      v-if="discardResourceTab"
      :request-name="
        discardResourceTab.kind === 'workspace'
          ? discardResourceTab.draft.name
          : discardResourceTab.kind === 'collection'
            ? discardResourceTab.draft.name
            : discardResourceTab.draft.name || t('environment.create')
      "
      @close="discardResourceTab = null"
      @discard="discardActiveResourceTab"
    />
    <CloseTabsDialog
      v-if="pendingBulkTabClose"
      :tab-count="pendingBulkTabClose.tabIds.length"
      :dirty-tab-names="pendingBulkTabClose.dirtyTabNames"
      :running-count="pendingBulkTabClose.runningCount"
      @close="pendingBulkTabClose = null"
      @confirm="confirmBulkTabClose"
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
  </div>
</template>
