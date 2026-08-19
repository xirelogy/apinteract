import { v7 as uuidV7 } from "uuid";

import {
  BrowserRequestSessionStorage,
  redactSecretVariableWrites,
  type LocalRequestSessionSnapshot,
  type LocalResourceTabSnapshot,
  type LocalRequestTabSnapshot,
  type RequestSessionStorage,
  type RestoredRequestTabEntry,
  type RestoredResourceTabEntry,
} from "@/control/persistence/request-session-storage";
import type {
  CollectionView,
  ImportApplyResult,
  ImportPlan,
  ImportProviderId,
  ImportProvidersView,
  ImportedRequest,
  EnvironmentListView,
  EnvironmentVariableWrite,
  EnvironmentView,
  ExecutionView,
  RequestBodyDefinition,
  RequestAttachment,
  RequestExchangeListView,
  RequestExchangeSummary,
  RequestExchangeView,
  RequestField,
  RequestRevisionSummary,
  RequestRevisionView,
  RequestView,
  TreeNode,
  EditableVariableScopeKind,
  TemporaryRequestVariableProfile,
  VariableProfileView,
  VariablePreviewResult,
  VariableWrite,
  WorkspaceSummary,
  WorkspaceView,
} from "@/model/contracts/backend";
import { useApplicationStore } from "@/control/state/application-store";
import type { SessionController } from "@/control/session/session-controller";
import type { BackendWebSocketClient } from "@/control/transport/websocket-client";
import {
  isRequestTabDirty,
  isResourceEditorTabDirty,
  type CollectionPropertiesDraft,
  type CollectionPropertiesTab,
  type EnvironmentDraft,
  type EnvironmentEditorTab,
  type ResourceEditorTab,
  type RequestRecoveryWarning,
  type ApplicationError,
  type ApplicationErrorCode,
  type RequestDraftInput,
  type RequestTab,
  type WorkspacePropertiesDraft,
  type WorkspacePropertiesTab,
} from "@/model/domain/application";

class WorkflowError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Values required to apply one previewed import as a new collection. */
export interface ImportApplyOptions {
  readonly providerId: ImportProviderId | null;
  readonly sourceName: string;
  readonly sourceText: string;
  readonly plan: ImportPlan;
  readonly selectedItemIds: readonly string[];
  readonly collectionName: string;
  readonly parentCollectionId: string | null;
}

/**
 * Coordinates backend commands with application view state.
 *
 * Workspace-tree operations use global foreground state. Request editing and
 * execution use independent tab state so multiple requests remain interactive.
 */
export class ApplicationController {
  readonly session: SessionController;
  readonly #webSocket: BackendWebSocketClient;
  readonly #requestSessionStorage: RequestSessionStorage;
  #previewNames: readonly string[] = [];
  #previewContext: {
    readonly parentCollectionId: string | null;
    readonly requestId: string | null;
    readonly requestTabId: string | null;
  } | null = null;
  #previewSequence = 0;
  #persistenceUserId: string | null = null;
  #persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  #stopPersistenceSubscription: (() => void) | null = null;
  #persistenceQueue: Promise<void> = Promise.resolve();
  #lastPersistenceSignature: string | null = null;

  constructor(
    session: SessionController,
    webSocket: BackendWebSocketClient,
    requestSessionStorage: RequestSessionStorage = new BrowserRequestSessionStorage(),
  ) {
    this.session = session;
    this.#webSocket = webSocket;
    this.#requestSessionStorage = requestSessionStorage;
    this.#webSocket.onEvent((event) => {
      if (
        event.type === "execution.response_head" ||
        event.type === "execution.progress" ||
        event.type === "execution.completed" ||
        event.type === "execution.failed"
      ) {
        this.#applyExecutionEvent(event.type, event.payload);
      }
    });
  }

  /** Loads visible workspaces without choosing a default selection. */
  async initializeWorkspace(): Promise<void> {
    await this.#run(async () => {
      const result = await this.#webSocket.command<{
        workspaces: WorkspaceSummary[];
      }>("workspace.list", {});
      const store = useApplicationStore();
      store.workspaces = result.workspaces;
      const userId = store.session?.user.userId;
      if (userId !== undefined) {
        await this.#restoreLocalRequestSession(userId, result.workspaces);
      }
    });
    const userId = useApplicationStore().session?.user.userId;
    if (userId !== undefined) {
      this.#startLocalSessionPersistence(userId);
    }
  }

  /** Logs out and removes request drafts retained for the current local user. */
  async logout(): Promise<void> {
    const userId = useApplicationStore().session?.user.userId ?? null;
    await this.#stopLocalSessionPersistence();
    try {
      await this.session.logout();
    } catch (cause) {
      if (userId !== null) this.#startLocalSessionPersistence(userId);
      throw cause;
    }
    if (userId !== null) {
      await this.#requestSessionStorage.clear(userId).catch(() => undefined);
    }
  }

  /** Restores valid local tabs and reconciles saved requests with backend state. */
  async #restoreLocalRequestSession(
    userId: string,
    workspaces: readonly WorkspaceSummary[],
  ): Promise<void> {
    const restored = await this.#requestSessionStorage
      .load(userId)
      .catch(() => null);
    if (restored === null) return;
    const workspaceIds = new Set(
      workspaces.map((workspace) => workspace.workspaceId),
    );
    let selectedWorkspaceId =
      restored.selectedWorkspaceId !== null &&
      workspaceIds.has(restored.selectedWorkspaceId)
        ? restored.selectedWorkspaceId
        : null;
    if (selectedWorkspaceId !== null) {
      try {
        await this.#selectWorkspace(selectedWorkspaceId);
      } catch {
        selectedWorkspaceId = null;
        this.#clearWorkspaceSelection();
      }
    }
    const tabs = await Promise.all(
      restored.tabs.map((entry) =>
        this.#restoreLocalRequestTab(entry, workspaceIds),
      ),
    );
    const store = useApplicationStore();
    store.requestTabs = tabs.filter((tab): tab is RequestTab => tab !== null);
    const resourceTabs = await Promise.all(
      restored.resourceTabs.map((entry) =>
        this.#restoreLocalResourceTab(entry, workspaceIds),
      ),
    );
    store.resourceTabs = resourceTabs.filter(
      (tab): tab is ResourceEditorTab => tab !== null,
    );
    const restoredIds = new Set([
      ...store.requestTabs.map((tab) => tab.tabId),
      ...store.resourceTabs.map((tab) => tab.tabId),
    ]);
    store.workbenchTabOrder = [
      ...restored.workbenchTabOrder.filter((tabId) => restoredIds.has(tabId)),
      ...[...restoredIds].filter(
        (tabId) => !restored.workbenchTabOrder.includes(tabId),
      ),
    ];
    store.activeRequestTabId = store.requestTabs.some(
      (tab) => tab.tabId === restored.activeRequestTabId,
    )
      ? restored.activeRequestTabId
      : (store.requestTabs.find(
          (tab) => tab.workspaceId === selectedWorkspaceId,
        )?.tabId ?? null);
    const visibleRestoredIds = new Set(
      [...store.requestTabs, ...store.resourceTabs]
        .filter((tab) => tab.workspaceId === selectedWorkspaceId)
        .map((tab) => tab.tabId),
    );
    store.activeWorkbenchTabId =
      restored.activeWorkbenchTabId !== null &&
      visibleRestoredIds.has(restored.activeWorkbenchTabId)
        ? restored.activeWorkbenchTabId
        : (store.workbenchTabOrder.find((tabId) =>
            visibleRestoredIds.has(tabId),
          ) ?? null);
    store.activeRequestTabId = store.requestTabs.some(
      (tab) => tab.tabId === store.activeWorkbenchTabId,
    )
      ? store.activeWorkbenchTabId
      : null;
    if (selectedWorkspaceId !== null) {
      await this.#refreshOpenRequestContexts(selectedWorkspaceId).catch(
        () => undefined,
      );
    }
  }

  /** Rebuilds one resource editor from current server data and a safe local draft. */
  async #restoreLocalResourceTab(
    entry: RestoredResourceTabEntry,
    workspaceIds: ReadonlySet<string>,
  ): Promise<ResourceEditorTab | null> {
    if (!workspaceIds.has(entry.workspaceId)) return null;
    const snapshot = entry.snapshot;
    try {
      if (entry.kind === "workspace" && entry.resourceId !== null) {
        const [workspace, profile] = await Promise.all([
          this.#webSocket.command<WorkspaceView>("workspace.get", {
            workspaceId: entry.resourceId,
          }),
          this.#webSocket.command<VariableProfileView>("variable_profile.get", {
            scopeKind: "workspace",
            scopeId: entry.resourceId,
          }),
        ]);
        const currentDraft = workspacePropertiesDraft(workspace, profile);
        const recovered =
          snapshot?.kind === "workspace" && snapshot.dirty ? snapshot : null;
        const draft =
          recovered === null
            ? currentDraft
            : cloneWorkspacePropertiesDraft(recovered.draft);
        return {
          kind: "workspace",
          tabId: entry.tabId,
          workspaceId: entry.workspaceId,
          workspace:
            recovered === null
              ? workspace
              : { ...workspace, revision: recovered.baseRevision },
          variableProfile:
            recovered === null
              ? profile
              : { ...profile, revision: recovered.baseVariableRevision },
          draft,
          baseline: cloneWorkspacePropertiesDraft(currentDraft),
          omittedSecretValues: recovered?.omittedSecretValues ?? false,
          busy: false,
        };
      }
      if (entry.kind === "collection" && entry.resourceId !== null) {
        const [collection, profile] = await Promise.all([
          this.#webSocket.command<CollectionView>("collection.get", {
            collectionId: entry.resourceId,
          }),
          this.#webSocket.command<VariableProfileView>("variable_profile.get", {
            scopeKind: "collection",
            scopeId: entry.resourceId,
          }),
        ]);
        const currentDraft = collectionPropertiesDraft(collection, profile);
        const recovered =
          snapshot?.kind === "collection" && snapshot.dirty ? snapshot : null;
        const draft =
          recovered === null
            ? currentDraft
            : cloneCollectionPropertiesDraft(recovered.draft);
        return {
          kind: "collection",
          tabId: entry.tabId,
          workspaceId: entry.workspaceId,
          collection:
            recovered === null
              ? collection
              : { ...collection, revision: recovered.baseRevision },
          variableProfile:
            recovered === null
              ? profile
              : { ...profile, revision: recovered.baseVariableRevision },
          draft,
          baseline: cloneCollectionPropertiesDraft(currentDraft),
          omittedSecretValues: recovered?.omittedSecretValues ?? false,
          busy: false,
        };
      }
      if (entry.kind === "environment") {
        if (entry.resourceId === null) {
          if (snapshot?.kind !== "environment") return null;
          return {
            kind: "environment",
            tabId: entry.tabId,
            workspaceId: entry.workspaceId,
            environment: null,
            draft: cloneEnvironmentDraft(snapshot.draft),
            baseline: null,
            omittedSecretValues: snapshot.omittedSecretValues,
            busy: false,
          };
        }
        const environment = await this.#webSocket.command<EnvironmentView>(
          "environment.get",
          { environmentId: entry.resourceId },
        );
        const currentDraft = environmentDraft(environment);
        const recovered =
          snapshot?.kind === "environment" && snapshot.dirty ? snapshot : null;
        return {
          kind: "environment",
          tabId: entry.tabId,
          workspaceId: entry.workspaceId,
          environment:
            recovered === null
              ? environment
              : { ...environment, revision: recovered.baseRevision ?? 0 },
          draft:
            recovered === null
              ? currentDraft
              : cloneEnvironmentDraft(recovered.draft),
          baseline: cloneEnvironmentDraft(currentDraft),
          omittedSecretValues: recovered?.omittedSecretValues ?? false,
          busy: false,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Rebuilds one local tab without trusting derived or transient browser state. */
  async #restoreLocalRequestTab(
    entry: RestoredRequestTabEntry,
    workspaceIds: ReadonlySet<string>,
  ): Promise<RequestTab | null> {
    if (!workspaceIds.has(entry.workspaceId)) return null;
    if (entry.requestId === null) {
      const snapshot = entry.snapshot;
      if (snapshot === null || snapshot.requestId !== null) return null;
      return {
        tabId: entry.tabId,
        workspaceId: entry.workspaceId,
        request: null,
        draft: cloneDraft(snapshot.draft),
        baseline: null,
        variableProfile: null,
        variableDraft: cloneVariableWrites(snapshot.variableDraft ?? []),
        variableBaseline: [],
        pendingParentCollectionId: snapshot.pendingParentCollectionId,
        inheritedTarget: "",
        inheritedHeaders: [],
        capturedExchange: null,
        execution: null,
        exchangeSummaries: [],
        selectedExchangeId: null,
        selectedExchange: null,
        revisions: [],
        viewingRevision: null,
        recoveryWarnings: snapshotRecoveryWarnings(snapshot),
        busy: false,
      };
    }
    try {
      const request = await this.#webSocket.command<RequestView>(
        "request.get",
        { requestId: entry.requestId },
      );
      if (request.workspaceId !== entry.workspaceId) return null;
      const baseline = requestToDraft(request);
      const snapshot = entry.snapshot;
      const warnings = new Set<RequestRecoveryWarning>(
        snapshot === null ? [] : snapshotRecoveryWarnings(snapshot),
      );
      const draft =
        snapshot?.draftDirty === true ? cloneDraft(snapshot.draft) : baseline;
      if (
        snapshot?.draftDirty === true &&
        snapshot.baseDraftRevision !== request.draftRevision
      ) {
        warnings.add("stale");
      }
      let variableProfile: VariableProfileView | null = null;
      let variableDraft: VariableWrite[] | null = null;
      let variableBaseline: VariableWrite[] | null = null;
      if (snapshot?.variableDirty === true && snapshot.variableDraft !== null) {
        variableProfile = await this.#webSocket.command<VariableProfileView>(
          "variable_profile.get",
          { scopeKind: "request", scopeId: request.requestId },
        );
        variableBaseline = variableViewsToWrites(variableProfile.variables);
        variableDraft = cloneVariableWrites(snapshot.variableDraft);
        if (snapshot.baseVariableRevision !== variableProfile.revision) {
          warnings.add("stale");
        }
      }
      const exchangeState = await this.#loadRequestExchangeState(
        request.requestId,
      );
      return {
        tabId: entry.tabId,
        workspaceId: entry.workspaceId,
        request,
        draft,
        baseline: cloneDraft(baseline),
        variableProfile,
        variableDraft,
        variableBaseline,
        pendingParentCollectionId: null,
        inheritedTarget: request.inheritedTarget,
        inheritedHeaders: request.inheritedHeaders.map((field) => ({
          ...field,
        })),
        capturedExchange: request.capturedExchange ?? null,
        execution: null,
        ...exchangeState,
        revisions: [],
        viewingRevision: null,
        recoveryWarnings: [...warnings],
        busy: false,
      };
    } catch {
      return null;
    }
  }

  /** Starts debounced persistence after restoration has finished mutating state. */
  #startLocalSessionPersistence(userId: string): void {
    if (this.#persistenceUserId === userId) return;
    this.#stopPersistenceSubscription?.();
    this.#persistenceUserId = userId;
    this.#lastPersistenceSignature = null;
    this.#stopPersistenceSubscription = useApplicationStore().$subscribe(
      () => this.#scheduleLocalSessionPersistence(),
      { detached: true, flush: "sync" },
    );
    this.#scheduleLocalSessionPersistence();
  }

  /** Stops future writes and waits for any already queued write to settle. */
  async #stopLocalSessionPersistence(): Promise<void> {
    this.#stopPersistenceSubscription?.();
    this.#stopPersistenceSubscription = null;
    this.#persistenceUserId = null;
    if (this.#persistenceTimer !== null) {
      clearTimeout(this.#persistenceTimer);
      this.#persistenceTimer = null;
    }
    await this.#persistenceQueue;
  }

  /** Coalesces rapid editor mutations into one local database transaction. */
  #scheduleLocalSessionPersistence(): void {
    if (this.#persistenceUserId === null) return;
    if (this.#persistenceTimer !== null) {
      clearTimeout(this.#persistenceTimer);
    }
    this.#persistenceTimer = setTimeout(() => {
      this.#persistenceTimer = null;
      this.#persistLocalRequestSession();
    }, 150);
  }

  /** Cancels the debounce and immediately queues the current local projection. */
  #flushLocalSessionPersistence(): void {
    if (this.#persistenceTimer !== null) {
      clearTimeout(this.#persistenceTimer);
      this.#persistenceTimer = null;
    }
    this.#persistLocalRequestSession();
  }

  /** Queues the latest serializable workbench projection in mutation order. */
  #persistLocalRequestSession(): void {
    const userId = this.#persistenceUserId;
    if (userId === null) return;
    const snapshot = localRequestSessionSnapshot(useApplicationStore());
    const signature = JSON.stringify(snapshot);
    if (signature === this.#lastPersistenceSignature) return;
    this.#lastPersistenceSignature = signature;
    this.#persistenceQueue = this.#persistenceQueue
      .then(() => this.#requestSessionStorage.save(userId, snapshot))
      .catch(() => {
        if (this.#lastPersistenceSignature === signature) {
          this.#lastPersistenceSignature = null;
        }
      });
  }

  /** Uploads one immutable multipart attachment with shared workflow errors. */
  async uploadRequestAttachment(
    workspaceId: string,
    file: File,
  ): Promise<RequestAttachment> {
    return this.#run(() =>
      this.session.uploadRequestAttachment(workspaceId, file),
    );
  }

  /** Creates, lists, and selects a new workspace. */
  async createWorkspace(name: string): Promise<void> {
    await this.#run(async () => {
      const workspace = await this.#webSocket.command<WorkspaceSummary>(
        "workspace.create",
        { name },
      );
      const store = useApplicationStore();
      store.workspaces.push(workspace);
      await this.#selectWorkspace(workspace.workspaceId);
    });
  }

  /** Selects a workspace and loads its root tree, or returns to no selection. */
  async selectWorkspace(workspaceId: string | null): Promise<void> {
    if (workspaceId === null) {
      this.#clearWorkspaceSelection();
      return;
    }
    await this.#run(() => this.#selectWorkspace(workspaceId));
  }

  /** Clears workspace-derived state while preserving open request tabs. */
  #clearWorkspaceSelection(): void {
    const store = useApplicationStore();
    store.selectedWorkspaceId = null;
    store.selectedWorkspace = null;
    store.rootNodes = [];
    store.environments = [];
    store.selectedEnvironmentId = null;
    store.selectedEnvironment = null;
    store.selectedVariableProfile = null;
    store.variablePreviews = [];
    this.#previewNames = [];
    this.#previewContext = null;
    this.#previewSequence += 1;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
    store.collectionChildren = {};
    store.expandedCollectionIds = [];
    store.error = null;
  }

  /** Loads a workspace root without nesting foreground busy state. */
  async #selectWorkspace(workspaceId: string): Promise<void> {
    const [result, environmentList, workspace] = await Promise.all([
      this.#webSocket.command<{ children: TreeNode[] }>("tree.list", {
        workspaceId,
        parentCollectionId: null,
      }),
      this.#webSocket.command<EnvironmentListView>("environment.list", {
        workspaceId,
      }),
      this.#webSocket.command<WorkspaceView>("workspace.get", { workspaceId }),
    ]);
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;
    store.selectedWorkspace = workspace;
    store.rootNodes = result.children;
    store.environments = environmentList.environments;
    store.selectedEnvironmentId = environmentList.selectedEnvironmentId;
    store.selectedEnvironment = null;
    store.selectedVariableProfile = null;
    store.variablePreviews = [];
    this.#previewNames = [];
    this.#previewContext = null;
    this.#previewSequence += 1;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
    store.collectionChildren = {};
    store.expandedCollectionIds = [];
    const visibleIds = new Set([
      ...store.requestTabs
        .filter((tab) => tab.workspaceId === workspaceId)
        .map((tab) => tab.tabId),
      ...store.resourceTabs
        .filter((tab) => tab.workspaceId === workspaceId)
        .map((tab) => tab.tabId),
    ]);
    const nextActiveId = store.workbenchTabOrder.find((tabId) =>
      visibleIds.has(tabId),
    );
    store.activeWorkbenchTabId = nextActiveId ?? null;
    store.activeRequestTabId =
      nextActiveId !== undefined &&
      store.requestTabs.some((tab) => tab.tabId === nextActiveId)
        ? nextActiveId
        : null;
    if (store.requestTabs.some((tab) => tab.workspaceId === workspaceId)) {
      await this.#refreshOpenRequestContexts(workspaceId).catch(
        () => undefined,
      );
    }
  }

  /** Loads the selected workspace's editable name and common headers. */
  async loadWorkspace(workspaceId: string): Promise<WorkspaceView> {
    return this.#run(async () => {
      const workspace = await this.#webSocket.command<WorkspaceView>(
        "workspace.get",
        { workspaceId },
      );
      useApplicationStore().selectedWorkspace = workspace;
      return workspace;
    });
  }

  /** Opens workspace properties once and activates the existing editor on repeat. */
  async openWorkspacePropertiesTab(workspaceId: string): Promise<void> {
    const store = useApplicationStore();
    const existing = store.resourceTabs.find(
      (tab) =>
        tab.kind === "workspace" && tab.workspace.workspaceId === workspaceId,
    );
    if (existing !== undefined) {
      this.activateWorkbenchTab(existing.tabId);
      return;
    }
    await this.#run(async () => {
      const [workspace, variableProfile] = await Promise.all([
        this.#webSocket.command<WorkspaceView>("workspace.get", {
          workspaceId,
        }),
        this.#webSocket.command<VariableProfileView>("variable_profile.get", {
          scopeKind: "workspace",
          scopeId: workspaceId,
        }),
      ]);
      const draft = workspacePropertiesDraft(workspace, variableProfile);
      const tab: WorkspacePropertiesTab = {
        kind: "workspace",
        tabId: uuidV7(),
        workspaceId,
        workspace,
        variableProfile,
        draft,
        baseline: cloneWorkspacePropertiesDraft(draft),
        busy: false,
      };
      this.#appendResourceTab(tab);
    });
  }

  /** Replaces the editable draft owned by one workspace-properties tab. */
  updateWorkspacePropertiesDraft(
    tabId: string,
    draft: WorkspacePropertiesDraft,
  ): void {
    this.#updateResourceTab(tabId, (tab) =>
      tab.kind === "workspace"
        ? { ...tab, draft: cloneWorkspacePropertiesDraft(draft) }
        : tab,
    );
  }

  /** Saves a workspace editor and advances its optimistic baselines in place. */
  async saveWorkspacePropertiesTab(tabId: string): Promise<void> {
    const tab = requireResourceTab(tabId, "workspace");
    const result = await this.updateWorkspaceProperties(
      tab.workspace.workspaceId,
      tab.workspace.revision,
      tab.draft.name,
      tab.draft.baseUrl,
      tab.draft.headers,
      tab.variableProfile.revision,
      tab.draft.variables,
    );
    const draft = workspacePropertiesDraft(result.workspace, result.profile);
    this.#updateResourceTab(tabId, (current) =>
      current.kind === "workspace"
        ? {
            ...current,
            workspace: result.workspace,
            variableProfile: result.profile,
            draft,
            baseline: cloneWorkspacePropertiesDraft(draft),
            omittedSecretValues: false,
          }
        : current,
    );
  }

  /** Saves workspace properties and variables as one coordinated UI action. */
  async updateWorkspaceProperties(
    workspaceId: string,
    expectedRevision: number,
    name: string,
    baseUrl: string,
    headers: readonly RequestField[],
    expectedVariableRevision: number,
    variables: readonly VariableWrite[],
  ): Promise<{ workspace: WorkspaceView; profile: VariableProfileView }> {
    return this.#run(async () => {
      const workspace = await this.#webSocket.command<WorkspaceView>(
        "workspace.update",
        { workspaceId, expectedRevision, name, baseUrl, headers },
      );
      const store = useApplicationStore();
      store.selectedWorkspace = workspace;
      store.workspaces = store.workspaces.map((candidate) =>
        candidate.workspaceId === workspaceId
          ? {
              workspaceId: workspace.workspaceId,
              name: workspace.name,
              role: workspace.role,
            }
          : candidate,
      );
      const profile = await this.#webSocket.command<VariableProfileView>(
        "variable_profile.update",
        {
          scopeKind: "workspace",
          scopeId: workspaceId,
          expectedRevision: expectedVariableRevision,
          variables,
        },
      );
      store.selectedVariableProfile = profile;
      await this.#refreshOpenRequestContexts(workspaceId);
      await this.#refreshVariablePreviews();
      return { workspace, profile };
    });
  }

  /** Deletes an owner-managed workspace and selects the next visible workspace. */
  async deleteWorkspace(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.#run(async () => {
      await this.#webSocket.command("workspace.delete", {
        workspaceId,
        expectedRevision,
      });
      const result = await this.#webSocket.command<{
        workspaces: WorkspaceSummary[];
      }>("workspace.list", {});
      const store = useApplicationStore();
      store.workspaces = result.workspaces;
      store.requestTabs = store.requestTabs.filter(
        (tab) => tab.workspaceId !== workspaceId,
      );
      store.resourceTabs = store.resourceTabs.filter(
        (tab) => tab.workspaceId !== workspaceId,
      );
      const retainedIds = new Set([
        ...store.requestTabs.map((tab) => tab.tabId),
        ...store.resourceTabs.map((tab) => tab.tabId),
      ]);
      store.workbenchTabOrder = store.workbenchTabOrder.filter((tabId) =>
        retainedIds.has(tabId),
      );
      store.activeRequestTabId = null;
      store.activeWorkbenchTabId = null;
      store.selectedWorkspaceId = null;
      store.selectedWorkspace = null;
      store.environments = [];
      store.selectedEnvironmentId = null;
      store.selectedEnvironment = null;
      store.selectedVariableProfile = null;
      store.variablePreviews = [];
      store.rootNodes = [];
      store.selectedCollectionId = null;
      store.selectedCollection = null;
      store.collectionChildren = {};
      store.expandedCollectionIds = [];
      this.#previewNames = [];
      this.#previewContext = null;
      this.#previewSequence += 1;
      const nextWorkspace = result.workspaces[0];
      if (nextWorkspace !== undefined) {
        await this.#selectWorkspace(nextWorkspace.workspaceId);
      }
    });
  }

  /** Selects the current session's environment for the active workspace. */
  async selectEnvironment(environmentId: string | null): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(async () => {
      const result = await this.#webSocket.command<{
        selectedEnvironmentId: string | null;
      }>("environment.select", { workspaceId, environmentId });
      store.selectedEnvironmentId = result.selectedEnvironmentId;
      await this.#refreshVariablePreviews();
    });
  }

  /** Refreshes redacted resolution hints for an explicit or active request scope. */
  async previewVariables(
    names: readonly string[],
    context?: {
      readonly parentCollectionId?: string | null;
      readonly requestId?: string | null;
    },
  ): Promise<void> {
    const store = useApplicationStore();
    const active = activeRequestTab(store);
    this.#previewNames = [...new Set(names)].slice(0, 100);
    this.#previewContext = {
      parentCollectionId:
        context === undefined
          ? (active?.request?.parentCollectionId ??
            active?.pendingParentCollectionId ??
            null)
          : (context.parentCollectionId ?? null),
      requestId:
        context === undefined
          ? (active?.request?.requestId ?? null)
          : (context.requestId ?? null),
      requestTabId: context === undefined ? (active?.tabId ?? null) : null,
    };
    await this.#refreshVariablePreviews();
  }

  /** Applies only the newest best-effort preview response for active context. */
  async #refreshVariablePreviews(): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = store.selectedWorkspaceId;
    const names = this.#previewNames;
    const context = this.#previewContext;
    const sequence = ++this.#previewSequence;
    if (workspaceId === null || names.length === 0) {
      store.variablePreviews = [];
      return;
    }
    try {
      const previewTab =
        context?.requestTabId === null || context?.requestTabId === undefined
          ? null
          : (store.requestTabs.find(
              (tab) => tab.tabId === context.requestTabId,
            ) ?? null);
      const result = await this.#webSocket.command<VariablePreviewResult>(
        "variable.preview",
        {
          workspaceId,
          parentCollectionId: context?.parentCollectionId ?? null,
          requestId: context?.requestId ?? null,
          names,
          ...(previewTab?.request === null
            ? { temporaryVariables: temporaryVariableProfile(previewTab) }
            : {}),
        },
      );
      if (sequence === this.#previewSequence) {
        store.variablePreviews = [...result.previews];
      }
    } catch {
      if (sequence === this.#previewSequence) {
        store.variablePreviews = [];
      }
    }
  }

  /** Loads one redacted workspace, collection, or request variable profile. */
  async loadVariableProfile(
    scopeKind: EditableVariableScopeKind,
    scopeId: string,
  ): Promise<VariableProfileView> {
    return this.#run(async () => {
      const profile = await this.#webSocket.command<VariableProfileView>(
        "variable_profile.get",
        { scopeKind, scopeId },
      );
      const store = useApplicationStore();
      store.selectedVariableProfile = profile;
      if (profile.scopeKind === "request") {
        const baseline = variableViewsToWrites(profile.variables);
        store.requestTabs = store.requestTabs.map((tab) =>
          tab.request?.requestId === profile.scopeId
            ? {
                ...tab,
                variableProfile: profile,
                variableDraft:
                  tab.variableDraft ?? cloneVariableWrites(baseline),
                variableBaseline:
                  tab.variableBaseline ?? cloneVariableWrites(baseline),
              }
            : tab,
        );
      }
      return profile;
    });
  }

  /** Loads inherited variables beneath one unsaved request's local draft. */
  async loadTemporaryVariableProfile(tabId: string): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request !== null) return;
    await this.#runTab(tabId, async () => {
      const profile = await this.#webSocket.command<VariableProfileView>(
        "variable_profile.get_temporary",
        {
          workspaceId: tab.workspaceId,
          parentCollectionId: tab.pendingParentCollectionId,
          scopeId: tab.tabId,
          scopeName: temporaryVariableScopeName(tab),
        },
      );
      this.#updateTab(tabId, (current) =>
        current.request === null
          ? {
              ...current,
              variableProfile: profile,
              variableDraft: current.variableDraft ?? [],
              variableBaseline: current.variableBaseline ?? [],
            }
          : current,
      );
    });
  }

  /** Saves one complete scope profile and refreshes active request previews. */
  async updateVariableProfile(
    scopeKind: EditableVariableScopeKind,
    scopeId: string,
    expectedRevision: number,
    variables: readonly VariableWrite[],
  ): Promise<VariableProfileView> {
    return this.#run(async () => {
      const profile = await this.#webSocket.command<VariableProfileView>(
        "variable_profile.update",
        { scopeKind, scopeId, expectedRevision, variables },
      );
      useApplicationStore().selectedVariableProfile = profile;
      await this.#refreshVariablePreviews();
      return profile;
    });
  }

  /** Opens a saved environment once, or creates an independent unsaved editor. */
  async openEnvironmentTab(environmentId: string | null): Promise<void> {
    const store = useApplicationStore();
    if (environmentId !== null) {
      const existing = store.resourceTabs.find(
        (tab) =>
          tab.kind === "environment" &&
          tab.environment?.environmentId === environmentId,
      );
      if (existing !== undefined) {
        this.activateWorkbenchTab(existing.tabId);
        return;
      }
    }
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    if (environmentId === null) {
      const tab: EnvironmentEditorTab = {
        kind: "environment",
        tabId: uuidV7(),
        workspaceId,
        environment: null,
        draft: { name: "", variables: [], includedEnvironmentIds: [] },
        baseline: null,
        busy: false,
      };
      this.#appendResourceTab(tab);
      return;
    }
    await this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.get",
        { environmentId },
      );
      const draft = environmentDraft(environment);
      const tab: EnvironmentEditorTab = {
        kind: "environment",
        tabId: uuidV7(),
        workspaceId: environment.workspaceId,
        environment,
        draft,
        baseline: cloneEnvironmentDraft(draft),
        busy: false,
      };
      this.#appendResourceTab(tab);
    });
  }

  /** Replaces the editable draft owned by one environment tab. */
  updateEnvironmentDraft(tabId: string, draft: EnvironmentDraft): void {
    this.#updateResourceTab(tabId, (tab) =>
      tab.kind === "environment"
        ? { ...tab, draft: cloneEnvironmentDraft(draft) }
        : tab,
    );
  }

  /** Creates or updates an environment and advances the tab baseline in place. */
  async saveEnvironmentTab(tabId: string): Promise<void> {
    const tab = requireResourceTab(tabId, "environment");
    const environment =
      tab.environment === null
        ? await this.createEnvironment(
            tab.draft.name,
            tab.draft.variables,
            tab.draft.includedEnvironmentIds,
          )
        : await this.updateEnvironment(
            tab.environment.environmentId,
            tab.environment.revision,
            tab.draft.name,
            tab.draft.variables,
            tab.draft.includedEnvironmentIds,
          );
    const draft = environmentDraft(environment);
    this.#updateResourceTab(tabId, (current) =>
      current.kind === "environment"
        ? {
            ...current,
            environment,
            draft,
            baseline: cloneEnvironmentDraft(draft),
            omittedSecretValues: false,
          }
        : current,
    );
  }

  /** Loads one redacted environment profile for management. */
  async loadEnvironment(environmentId: string): Promise<EnvironmentView> {
    return this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.get",
        { environmentId },
      );
      useApplicationStore().selectedEnvironment = environment;
      return environment;
    });
  }

  /** Creates an environment and reloads session-aware summaries. */
  async createEnvironment(
    name: string,
    variables: readonly EnvironmentVariableWrite[],
    includedEnvironmentIds: readonly string[],
  ): Promise<EnvironmentView> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    return this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.create",
        { workspaceId, name, variables, includedEnvironmentIds },
      );
      await this.#reloadEnvironments(workspaceId);
      store.selectedEnvironment = environment;
      await this.#refreshVariablePreviews();
      return environment;
    });
  }

  /** Saves one complete redacted environment profile. */
  async updateEnvironment(
    environmentId: string,
    expectedRevision: number,
    name: string,
    variables: readonly EnvironmentVariableWrite[],
    includedEnvironmentIds: readonly string[],
  ): Promise<EnvironmentView> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    return this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.update",
        {
          environmentId,
          expectedRevision,
          name,
          variables,
          includedEnvironmentIds,
        },
      );
      await this.#reloadEnvironments(workspaceId);
      store.selectedEnvironment = environment;
      await this.#refreshVariablePreviews();
      return environment;
    });
  }

  /** Deletes one current environment and refreshes cleared selection state. */
  async deleteEnvironment(
    environmentId: string,
    expectedRevision: number,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(async () => {
      await this.#webSocket.command("environment.delete", {
        environmentId,
        expectedRevision,
      });
      const removedTabIds = new Set(
        store.resourceTabs
          .filter(
            (tab) =>
              tab.kind === "environment" &&
              tab.environment?.environmentId === environmentId,
          )
          .map((tab) => tab.tabId),
      );
      store.resourceTabs = store.resourceTabs.filter(
        (tab) => !removedTabIds.has(tab.tabId),
      );
      store.workbenchTabOrder = store.workbenchTabOrder.filter(
        (tabId) => !removedTabIds.has(tabId),
      );
      if (
        store.activeWorkbenchTabId !== null &&
        removedTabIds.has(store.activeWorkbenchTabId)
      ) {
        this.#activateNearestWorkbenchTab();
      }
      store.selectedEnvironment = null;
      await this.#reloadEnvironments(workspaceId);
      await this.#refreshVariablePreviews();
    });
  }

  /** Refreshes environment summaries and selection for one workspace. */
  async #reloadEnvironments(workspaceId: string): Promise<void> {
    const result = await this.#webSocket.command<EnvironmentListView>(
      "environment.list",
      { workspaceId },
    );
    const store = useApplicationStore();
    store.environments = result.environments;
    store.selectedEnvironmentId = result.selectedEnvironmentId;
  }

  /** Creates a collection under the workspace root or another collection. */
  async createCollection(
    name: string,
    parentCollectionId: string | null,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(async () => {
      await this.#webSocket.command("collection.create", {
        workspaceId,
        parentCollectionId,
        name,
      });
      if (parentCollectionId === null) {
        await this.#reloadCollection(workspaceId, null);
      } else {
        await this.#selectCollection(parentCollectionId);
      }
    });
  }

  /** Persists and reloads one complete sibling order without moving parents. */
  async reorderTreeNodes(
    parentCollectionId: string | null,
    orderedNodeIds: readonly string[],
    expectedOrderRevision: number,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(async () => {
      await this.#webSocket.command("tree.reorder", {
        workspaceId,
        parentCollectionId,
        expectedOrderRevision,
        orderedNodeIds,
      });
      await this.#reloadCollection(workspaceId, parentCollectionId);
    });
  }

  /** Reparents one tree node relative to a visible destination node. */
  async moveTreeNode(
    nodeId: string,
    targetNodeId: string,
    placement: "before" | "inside" | "after",
    expectedSourceOrderRevision: number,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(async () => {
      const result = await this.#webSocket.command<{
        sourceParentCollectionId: string | null;
        targetParentCollectionId: string | null;
      }>("tree.move", {
        workspaceId,
        nodeId,
        targetNodeId,
        placement,
        expectedSourceOrderRevision,
      });
      await Promise.all([
        this.#reloadCollection(workspaceId, result.sourceParentCollectionId),
        this.#reloadCollection(workspaceId, result.targetParentCollectionId),
      ]);
      if (placement === "inside" && result.targetParentCollectionId !== null) {
        store.expandedCollectionIds = includeOnce(
          store.expandedCollectionIds,
          result.targetParentCollectionId,
        );
      }
      await this.#refreshOpenRequestContexts(workspaceId);
    });
  }

  /** Selects and expands a collection after loading its direct children. */
  async selectCollection(collectionId: string): Promise<void> {
    await this.#run(() => this.#selectCollection(collectionId));
  }

  /** Loads one collection branch without nesting foreground busy state. */
  async #selectCollection(collectionId: string): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    const [, collection] = await Promise.all([
      this.#reloadCollection(workspaceId, collectionId),
      this.#webSocket.command<CollectionView>("collection.get", {
        collectionId,
      }),
    ]);
    store.selectedCollectionId = collectionId;
    store.selectedCollection = collection;
    store.activeRequestTabId = null;
    store.activeWorkbenchTabId = null;
    store.expandedCollectionIds = includeOnce(
      store.expandedCollectionIds,
      collectionId,
    );
  }

  /** Opens collection properties once and activates the existing editor on repeat. */
  async openCollectionPropertiesTab(collectionId: string): Promise<void> {
    const store = useApplicationStore();
    const existing = store.resourceTabs.find(
      (tab) =>
        tab.kind === "collection" &&
        tab.collection.collectionId === collectionId,
    );
    if (existing !== undefined) {
      this.activateWorkbenchTab(existing.tabId);
      return;
    }
    await this.#run(async () => {
      const [collection, variableProfile] = await Promise.all([
        this.#webSocket.command<CollectionView>("collection.get", {
          collectionId,
        }),
        this.#webSocket.command<VariableProfileView>("variable_profile.get", {
          scopeKind: "collection",
          scopeId: collectionId,
        }),
      ]);
      const draft = collectionPropertiesDraft(collection, variableProfile);
      const tab: CollectionPropertiesTab = {
        kind: "collection",
        tabId: uuidV7(),
        workspaceId: collection.workspaceId,
        collection,
        variableProfile,
        draft,
        baseline: cloneCollectionPropertiesDraft(draft),
        busy: false,
      };
      store.selectedCollectionId = collectionId;
      store.selectedCollection = collection;
      store.expandedCollectionIds = includeOnce(
        store.expandedCollectionIds,
        collectionId,
      );
      this.#appendResourceTab(tab);
    });
  }

  /** Replaces the editable draft owned by one collection-properties tab. */
  updateCollectionPropertiesDraft(
    tabId: string,
    draft: CollectionPropertiesDraft,
  ): void {
    this.#updateResourceTab(tabId, (tab) =>
      tab.kind === "collection"
        ? { ...tab, draft: cloneCollectionPropertiesDraft(draft) }
        : tab,
    );
  }

  /** Saves a collection editor and advances its optimistic baselines in place. */
  async saveCollectionPropertiesTab(tabId: string): Promise<void> {
    const tab = requireResourceTab(tabId, "collection");
    const result = await this.updateCollectionProperties(
      tab.collection.collectionId,
      tab.collection.revision,
      tab.draft.name,
      tab.draft.pathPrefix,
      tab.draft.headers,
      tab.variableProfile.revision,
      tab.draft.variables,
    );
    const draft = collectionPropertiesDraft(result.collection, result.profile);
    this.#updateResourceTab(tabId, (current) =>
      current.kind === "collection"
        ? {
            ...current,
            collection: result.collection,
            variableProfile: result.profile,
            draft,
            baseline: cloneCollectionPropertiesDraft(draft),
            omittedSecretValues: false,
          }
        : current,
    );
  }

  /** Saves a collection's name, headers, and variable profile as one UI operation. */
  async updateCollectionProperties(
    collectionId: string,
    expectedRevision: number,
    name: string,
    pathPrefix: string,
    headers: readonly RequestField[],
    expectedVariableRevision: number,
    variables: readonly VariableWrite[],
  ): Promise<{ collection: CollectionView; profile: VariableProfileView }> {
    return this.#run(async () => {
      const collection = await this.#webSocket.command<CollectionView>(
        "collection.update",
        { collectionId, expectedRevision, name, pathPrefix, headers },
      );
      const store = useApplicationStore();
      if (store.selectedCollectionId === collectionId) {
        store.selectedCollection = collection;
      }
      await this.#reloadCollection(
        collection.workspaceId,
        collection.parentCollectionId,
      );
      const profile = await this.#webSocket.command<VariableProfileView>(
        "variable_profile.update",
        {
          scopeKind: "collection",
          scopeId: collectionId,
          expectedRevision: expectedVariableRevision,
          variables,
        },
      );
      store.selectedVariableProfile = profile;
      await this.#refreshOpenRequestContexts(collection.workspaceId);
      await this.#refreshVariablePreviews();
      return { collection, profile };
    });
  }

  /** Deletes a collection subtree and removes its loaded tabs and navigation state. */
  async deleteCollection(
    collectionId: string,
    expectedRevision: number,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    const collectionTab = store.resourceTabs.find(
      (tab) =>
        tab.kind === "collection" &&
        tab.collection.collectionId === collectionId,
    );
    const collection =
      collectionTab?.kind === "collection"
        ? collectionTab.collection
        : store.selectedCollection;
    const parentCollectionId =
      collection?.collectionId === collectionId
        ? collection.parentCollectionId
        : null;
    const deleted = loadedCollectionSubtree(
      collectionId,
      store.collectionChildren,
    );
    await this.#run(async () => {
      await this.#webSocket.command("collection.delete", {
        collectionId,
        expectedRevision,
      });
      store.requestTabs = store.requestTabs.filter((tab) => {
        const request = tab.request;
        return !(
          tab.workspaceId === workspaceId &&
          ((request !== null && deleted.requestIds.has(request.requestId)) ||
            (request !== null &&
              request.parentCollectionId !== null &&
              deleted.collectionIds.has(request.parentCollectionId)) ||
            (tab.pendingParentCollectionId !== null &&
              deleted.collectionIds.has(tab.pendingParentCollectionId)))
        );
      });
      store.resourceTabs = store.resourceTabs.filter(
        (tab) =>
          tab.kind !== "collection" ||
          !deleted.collectionIds.has(tab.collection.collectionId),
      );
      const retainedIds = new Set([
        ...store.requestTabs.map((tab) => tab.tabId),
        ...store.resourceTabs.map((tab) => tab.tabId),
      ]);
      store.workbenchTabOrder = store.workbenchTabOrder.filter((tabId) =>
        retainedIds.has(tabId),
      );
      if (
        !store.requestTabs.some((tab) => tab.tabId === store.activeRequestTabId)
      ) {
        store.activeRequestTabId = null;
      }
      if (
        store.activeWorkbenchTabId !== null &&
        !retainedIds.has(store.activeWorkbenchTabId)
      ) {
        this.#activateNearestWorkbenchTab();
      }
      store.selectedCollectionId = null;
      store.selectedCollection = null;
      store.selectedVariableProfile = null;
      store.variablePreviews = [];
      store.expandedCollectionIds = store.expandedCollectionIds.filter(
        (id) => !deleted.collectionIds.has(id),
      );
      for (const id of deleted.collectionIds) {
        delete store.collectionChildren[id];
      }
      this.#previewNames = [];
      this.#previewContext = null;
      this.#previewSequence += 1;
      await this.#reloadCollection(workspaceId, parentCollectionId);
    });
  }

  /** Refreshes one root or collection child list from the backend. */
  async #reloadCollection(
    workspaceId: string,
    parentCollectionId: string | null,
  ): Promise<void> {
    const result = await this.#webSocket.command<{ children: TreeNode[] }>(
      "tree.list",
      { workspaceId, parentCollectionId },
    );
    const store = useApplicationStore();
    if (parentCollectionId === null) {
      store.rootNodes = result.children;
    } else {
      store.collectionChildren = {
        ...store.collectionChildren,
        [parentCollectionId]: result.children,
      };
    }
  }

  /** Loads collection children for a secondary tree without changing selection. */
  async loadCollectionChildren(collectionId: string): Promise<void> {
    const store = useApplicationStore();
    if (store.collectionChildren[collectionId] !== undefined) {
      return;
    }
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    await this.#run(() => this.#reloadCollection(workspaceId, collectionId));
  }

  /** Expands an unloaded collection without selecting it, or collapses it. */
  async toggleCollection(collectionId: string): Promise<void> {
    const store = useApplicationStore();
    if (store.expandedCollectionIds.includes(collectionId)) {
      store.expandedCollectionIds = store.expandedCollectionIds.filter(
        (candidate) => candidate !== collectionId,
      );
      return;
    }
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    if (store.collectionChildren[collectionId] === undefined) {
      await this.#run(() => this.#reloadCollection(workspaceId, collectionId));
    }
    store.expandedCollectionIds = includeOnce(
      store.expandedCollectionIds,
      collectionId,
    );
  }

  /** Opens a new unsaved request tab in the selected workspace. */
  createTemporaryRequest(parentCollectionId: string | null = null): void {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    const tab: RequestTab = {
      tabId: uuidV7(),
      workspaceId,
      request: null,
      draft: emptyDraft(parentCollectionId === null ? "absolute" : "composed"),
      baseline: null,
      variableProfile: null,
      variableDraft: [],
      variableBaseline: [],
      pendingParentCollectionId: parentCollectionId,
      inheritedTarget:
        parentCollectionId === null
          ? (store.selectedWorkspace?.baseUrl ?? "")
          : store.selectedCollectionId === parentCollectionId
            ? joinTargetPreview(
                store.selectedWorkspace?.baseUrl ?? "",
                store.selectedCollection?.effectivePath ?? "",
              )
            : "",
      inheritedHeaders:
        parentCollectionId === null
          ? (store.selectedWorkspace?.headers.map((field) => ({ ...field })) ??
            [])
          : store.selectedCollectionId === parentCollectionId
            ? (store.selectedCollection?.effectiveHeaders.map((field) => ({
                ...field,
              })) ?? [])
            : [],
      capturedExchange: null,
      execution: null,
      exchangeSummaries: [],
      selectedExchangeId: null,
      selectedExchange: null,
      revisions: [],
      viewingRevision: null,
      busy: false,
    };
    store.requestTabs.push(tab);
    store.activeRequestTabId = tab.tabId;
    store.workbenchTabOrder.push(tab.tabId);
    store.activeWorkbenchTabId = tab.tabId;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
  }

  /** Lists declarative metadata for import providers installed by the backend. */
  listImportProviders(): Promise<ImportProvidersView> {
    return this.#run(() =>
      this.#webSocket.command<ImportProvidersView>("import.providers", {}),
    );
  }

  /** Parses one source into a mutation-free provider preview. */
  previewImport(
    providerId: ImportProviderId | null,
    sourceName: string,
    sourceText: string,
  ): Promise<ImportPlan> {
    return this.#run(() =>
      this.#webSocket.command<ImportPlan>("import.preview", {
        providerId,
        sourceName,
        sourceText,
      }),
    );
  }

  /** Opens one preview item as an unsaved request without persistent mutation. */
  createImportedTemporaryRequest(
    plan: ImportPlan,
    imported: ImportedRequest,
  ): void {
    this.createTemporaryRequest(null);
    const store = useApplicationStore();
    const tabId = requireSelection(store.activeRequestTabId);
    const collectionChain = importedCollectionChain(plan, imported);
    const composedPrefix = collectionChain.reduce(
      (prefix, collection) => joinTargetPreview(prefix, collection.pathPrefix),
      plan.pathPrefix,
    );
    const absolutePrefix = composedPrefix.includes("://");
    const targetMode =
      imported.targetMode === "composed" && absolutePrefix
        ? "absolute"
        : imported.targetMode;
    const targetUrl =
      imported.targetMode === "composed"
        ? joinTargetPreview(composedPrefix, imported.targetUrl)
        : imported.targetUrl;
    this.#updateTab(tabId, (tab) => ({
      ...tab,
      draft: {
        name: imported.name,
        method: imported.method,
        targetMode,
        targetUrl,
        query: imported.query.map((field) => ({ ...field })),
        headers: imported.headers.map((field) => ({ ...field })),
        requestBody: cloneRequestBody(imported.requestBody),
        body: imported.body,
        preRequestScript: imported.preRequestScript,
        postResponseScript: imported.postResponseScript,
      },
      variableDraft: cloneVariableWrites(
        mergeImportedVariables([
          plan.variables,
          ...collectionChain.map((collection) => collection.variables),
          imported.variables,
        ]),
      ),
      variableBaseline: [],
      inheritedTarget:
        targetMode === "composed"
          ? (store.selectedWorkspace?.baseUrl ?? "")
          : "",
      capturedExchange: imported.capturedExchange ?? null,
      execution: null,
      exchangeSummaries: [],
      selectedExchangeId: null,
      selectedExchange: null,
    }));
  }

  /** Re-parses and atomically applies selected preview items to one destination. */
  async applyImport(options: ImportApplyOptions): Promise<ImportApplyResult> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    return this.#run(async () => {
      const result = await this.#webSocket.command<ImportApplyResult>(
        "import.apply",
        {
          providerId: options.providerId,
          sourceName: options.sourceName,
          sourceText: options.sourceText,
          workspaceId,
          parentCollectionId: options.parentCollectionId,
          collectionName: options.collectionName,
          selectedItemIds: options.selectedItemIds,
          expectedSourceFingerprint: options.plan.sourceFingerprint,
        },
      );
      await this.#reloadCollection(workspaceId, options.parentCollectionId);
      await this.#reloadCollection(workspaceId, result.collectionId);
      store.expandedCollectionIds = includeOnce(
        store.expandedCollectionIds,
        result.collectionId,
      );
      const capturedRequests = result.requests.filter(
        (request) => request.capturedExchange !== undefined,
      );
      const requestsToOpen =
        capturedRequests.length > 0
          ? capturedRequests
          : result.requests.slice(0, 1);
      let firstOpenedTabId: string | null = null;
      for (const request of requestsToOpen) {
        const tabId = this.#openRequestTab(request);
        firstOpenedTabId ??= tabId;
        await this.#refreshRequestExchanges(tabId, request.requestId);
      }
      if (firstOpenedTabId !== null) {
        store.activeRequestTabId = firstOpenedTabId;
        store.activeWorkbenchTabId = firstOpenedTabId;
      }
      return result;
    });
  }

  /** Activates an already open request tab. */
  activateRequestTab(tabId: string): void {
    const store = useApplicationStore();
    if (store.requestTabs.some((tab) => tab.tabId === tabId)) {
      store.activeRequestTabId = tabId;
      store.activeWorkbenchTabId = tabId;
      store.selectedCollectionId = null;
      store.selectedCollection = null;
    }
  }

  /** Activates any open workbench tab while retaining request-only selection state. */
  activateWorkbenchTab(tabId: string): void {
    const store = useApplicationStore();
    if (store.requestTabs.some((tab) => tab.tabId === tabId)) {
      this.activateRequestTab(tabId);
      return;
    }
    if (store.resourceTabs.some((tab) => tab.tabId === tabId)) {
      store.activeWorkbenchTabId = tabId;
      store.activeRequestTabId = null;
    }
  }

  /** Closes one request tab and activates its nearest remaining neighbor. */
  closeRequestTab(tabId: string): void {
    const store = useApplicationStore();
    const index = store.requestTabs.findIndex((tab) => tab.tabId === tabId);
    if (index < 0) {
      return;
    }
    store.requestTabs.splice(index, 1);
    store.workbenchTabOrder = store.workbenchTabOrder.filter(
      (candidate) => candidate !== tabId,
    );
    if (store.activeRequestTabId === tabId) {
      store.activeRequestTabId = null;
    }
    if (store.activeWorkbenchTabId === tabId) {
      this.#activateNearestWorkbenchTab();
    }
    this.#flushLocalSessionPersistence();
  }

  /** Closes one resource editor and activates its nearest remaining neighbor. */
  closeResourceTab(tabId: string): void {
    const store = useApplicationStore();
    if (!store.resourceTabs.some((tab) => tab.tabId === tabId)) return;
    store.resourceTabs = store.resourceTabs.filter(
      (tab) => tab.tabId !== tabId,
    );
    store.workbenchTabOrder = store.workbenchTabOrder.filter(
      (candidate) => candidate !== tabId,
    );
    if (store.activeWorkbenchTabId === tabId) {
      this.#activateNearestWorkbenchTab();
    }
    this.#flushLocalSessionPersistence();
  }

  /** Opens a saved request once or activates its existing tab. */
  async selectRequest(requestId: string): Promise<void> {
    const store = useApplicationStore();
    const existing = store.requestTabs.find(
      (tab) => tab.request?.requestId === requestId,
    );
    if (existing !== undefined) {
      this.activateRequestTab(existing.tabId);
      return;
    }
    await this.#run(async () => {
      const request = await this.#webSocket.command<RequestView>(
        "request.get",
        { requestId },
      );
      const tabId = this.#openRequestTab(request);
      await this.#refreshRequestExchanges(tabId, request.requestId);
    });
  }

  /** Loads one saved request without changing the current tab selection. */
  async loadRequest(requestId: string): Promise<RequestView> {
    return this.#run(() =>
      this.#webSocket.command<RequestView>("request.get", { requestId }),
    );
  }

  /** Duplicates a saved request, refreshes its parent, and opens the result. */
  async duplicateRequest(requestId: string, name: string): Promise<void> {
    await this.#run(async () => {
      const duplicate = await this.#webSocket.command<RequestView>(
        "request.duplicate",
        { requestId, name },
      );
      await this.#reloadCollection(
        duplicate.workspaceId,
        duplicate.parentCollectionId,
      );
      const tabId = this.#openRequestTab(duplicate);
      await this.#refreshRequestExchanges(tabId, duplicate.requestId);
    });
  }

  /** Deletes one saved request and removes every tab and preview it owns. */
  async deleteRequest(request: RequestView): Promise<void> {
    await this.#run(async () => {
      const store = useApplicationStore();
      const activeIndex = store.requestTabs.findIndex(
        (tab) => tab.tabId === store.activeRequestTabId,
      );
      const activeRequestId =
        activeIndex < 0
          ? null
          : (store.requestTabs[activeIndex]?.request?.requestId ?? null);
      await this.#webSocket.command("request.delete", {
        requestId: request.requestId,
        expectedDraftRevision: request.draftRevision,
      });
      store.requestTabs = store.requestTabs.filter(
        (tab) => tab.request?.requestId !== request.requestId,
      );
      const retainedRequestIds = new Set(
        store.requestTabs.map((tab) => tab.tabId),
      );
      store.workbenchTabOrder = store.workbenchTabOrder.filter(
        (tabId) =>
          retainedRequestIds.has(tabId) ||
          store.resourceTabs.some((tab) => tab.tabId === tabId),
      );
      if (activeRequestId === request.requestId) {
        store.activeRequestTabId =
          store.requestTabs[activeIndex]?.tabId ??
          store.requestTabs[activeIndex - 1]?.tabId ??
          null;
        store.activeWorkbenchTabId = store.activeRequestTabId;
      }
      if (
        store.selectedVariableProfile?.scopeKind === "request" &&
        store.selectedVariableProfile.scopeId === request.requestId
      ) {
        store.selectedVariableProfile = null;
      }
      if (activeRequestId === request.requestId) {
        store.variablePreviews = [];
        this.#previewNames = [];
        this.#previewContext = null;
        this.#previewSequence += 1;
      }
      await this.#reloadCollection(
        request.workspaceId,
        request.parentCollectionId,
      );
    });
  }

  /** Replaces editable content for one open request tab. */
  updateRequestDraft(tabId: string, draft: RequestDraftInput): void {
    this.#updateTab(tabId, (tab) => ({ ...tab, draft: cloneDraft(draft) }));
  }

  /** Replaces one request tab's editable variable profile. */
  updateRequestVariableDraft(
    tabId: string,
    variables: readonly VariableWrite[],
  ): void {
    this.#updateTab(tabId, (tab) => ({
      ...tab,
      variableDraft: cloneVariableWrites(variables),
    }));
    if (this.#previewContext?.requestTabId === tabId) {
      void this.#refreshVariablePreviews();
    }
  }

  /** Persists edits for one already saved request tab. */
  async saveRequest(tabId: string, draft: RequestDraftInput): Promise<void> {
    this.updateRequestDraft(tabId, draft);
    const tab = requireTab(tabId);
    if (tab.request === null) {
      return;
    }
    await this.#runTab(tabId, async () => {
      const variableUpdate =
        tab.variableProfile === null ||
        tab.variableDraft === null ||
        JSON.stringify(tab.variableDraft) ===
          JSON.stringify(tab.variableBaseline)
          ? null
          : {
              expectedRevision: tab.variableProfile.revision,
              variables: tab.variableDraft,
            };
      const updated = await this.#webSocket.command<RequestView>(
        "request.update",
        {
          requestId: tab.request?.requestId,
          expectedDraftRevision: tab.request?.draftRevision,
          name: draft.name,
          ...executableDraft(draft),
          ...(variableUpdate === null
            ? {}
            : { variableProfile: variableUpdate }),
        },
      );
      const updatedVariableProfile =
        variableUpdate === null
          ? tab.variableProfile
          : await this.#webSocket.command<VariableProfileView>(
              "variable_profile.get",
              { scopeKind: "request", scopeId: updated.requestId },
            );
      const savedDraft = requestToDraft(updated);
      const savedVariables =
        tab.variableDraft === null
          ? null
          : cloneVariableWrites(tab.variableDraft);
      this.#updateTab(tabId, (current) => ({
        ...current,
        request: updated,
        draft: savedDraft,
        baseline: cloneDraft(savedDraft),
        variableProfile: updatedVariableProfile,
        variableDraft: savedVariables,
        variableBaseline:
          savedVariables === null ? null : cloneVariableWrites(savedVariables),
        recoveryWarnings: [],
      }));
      if (updatedVariableProfile !== null) {
        useApplicationStore().selectedVariableProfile = updatedVariableProfile;
      }
      replaceLoadedRequestNode(updated);
      await this.#refreshRequestRevisions(tabId, updated.requestId);
    });
  }

  /** Saves a temporary tab into a selected collection without replacing it. */
  async saveTemporaryRequest(
    tabId: string,
    name: string,
    parentCollectionId: string,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request !== null) {
      return;
    }
    await this.#runTab(tabId, async () => {
      const request = await this.#webSocket.command<RequestView>(
        "request.create",
        {
          workspaceId: tab.workspaceId,
          parentCollectionId,
          name,
          ...executableDraft(tab.draft),
          variables: tab.variableDraft ?? [],
        },
      );
      const savedDraft = requestToDraft(request);
      const pendingVariables = cloneVariableWrites(tab.variableDraft ?? []);
      this.#updateTab(tabId, (current) => ({
        ...current,
        request,
        draft: savedDraft,
        baseline: cloneDraft(savedDraft),
        pendingParentCollectionId: null,
        inheritedTarget: request.inheritedTarget,
        inheritedHeaders: request.inheritedHeaders.map((field) => ({
          ...field,
        })),
        variableProfile: null,
        variableDraft: cloneVariableWrites(pendingVariables),
        variableBaseline: cloneVariableWrites(pendingVariables),
        revisions: [],
        viewingRevision: null,
        recoveryWarnings: [],
      }));
      const variableProfile =
        await this.#webSocket.command<VariableProfileView>(
          "variable_profile.get",
          { scopeKind: "request", scopeId: request.requestId },
        );
      const savedVariables = variableViewsToWrites(variableProfile.variables);
      this.#updateTab(tabId, (current) => ({
        ...current,
        variableProfile,
        variableDraft: cloneVariableWrites(savedVariables),
        variableBaseline: cloneVariableWrites(savedVariables),
      }));
      await this.#reloadCollection(tab.workspaceId, parentCollectionId);
    });
  }

  /** Executes saved or temporary content from one request tab. */
  async executeRequest(tabId: string, draft: RequestDraftInput): Promise<void> {
    this.updateRequestDraft(tabId, draft);
    let tab = requireTab(tabId);
    if (tab.request !== null) {
      await this.saveRequest(tabId, draft);
      tab = requireTab(tabId);
    }
    await this.#runTab(tabId, async () => {
      const execution =
        tab.request === null
          ? await this.#webSocket.command<ExecutionView>(
              "execution.start_temporary",
              {
                workspaceId: tab.workspaceId,
                parentCollectionId: tab.pendingParentCollectionId,
                request: executableDraft(tab.draft),
                temporaryVariables: temporaryVariableProfile(tab),
              },
            )
          : await this.#webSocket.command<ExecutionView>("execution.start", {
              requestId: tab.request.requestId,
            });
      this.#updateTab(tabId, (current) => ({
        ...(current.request === null
          ? { ...current, execution }
          : withLiveExecution(current, execution)),
      }));
    });
  }

  /** Selects and loads one immutable response exchange for a saved request. */
  async selectRequestExchange(
    tabId: string,
    exchangeId: string,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    const summary = tab.exchangeSummaries.find(
      (candidate) => candidate.exchangeId === exchangeId,
    );
    if (summary === undefined) return;
    if (tab.execution?.executionId === exchangeId) {
      this.#updateTab(tabId, (current) => ({
        ...current,
        selectedExchangeId: exchangeId,
        selectedExchange: { summary, execution: tab.execution! },
      }));
      return;
    }
    await this.#runTab(tabId, async () => {
      const selectedExchange =
        await this.#webSocket.command<RequestExchangeView>(
          "request.exchange.get",
          {
            requestId: tab.request!.requestId,
            exchangeId,
            kind: summary.kind,
          },
        );
      this.#updateTab(tabId, (current) => ({
        ...current,
        selectedExchangeId: exchangeId,
        selectedExchange,
      }));
    });
  }

  /** Loads immutable history for one saved request tab. */
  async loadRequestRevisions(tabId: string): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    await this.#runTab(tabId, () =>
      this.#refreshRequestRevisions(tabId, tab.request!.requestId),
    );
  }

  /** Switches the whole request editor to one immutable revision or the draft. */
  async selectRequestRevision(
    tabId: string,
    revisionId: string | null,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    if (revisionId === null) {
      this.#updateTab(tabId, (current) => ({
        ...current,
        viewingRevision: null,
      }));
      return;
    }
    await this.#runTab(tabId, async () => {
      const revision = await this.#webSocket.command<RequestRevisionView>(
        "request.revision.get",
        { requestId: tab.request!.requestId, revisionId },
      );
      this.#updateTab(tabId, (current) => ({
        ...current,
        viewingRevision: revision,
      }));
    });
  }

  /** Assigns or removes the user-facing name for one immutable revision. */
  async nameRequestRevision(
    tabId: string,
    revisionId: string,
    name: string | null,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    await this.#runTab(tabId, async () => {
      await this.#webSocket.command<RequestRevisionSummary>(
        "request.revision.name",
        { requestId: tab.request!.requestId, revisionId, name },
      );
      await this.#refreshRequestRevisions(tabId, tab.request!.requestId);
      if (tab.viewingRevision?.revisionId === revisionId) {
        const revision = await this.#webSocket.command<RequestRevisionView>(
          "request.revision.get",
          { requestId: tab.request!.requestId, revisionId },
        );
        this.#updateTab(tabId, (current) => ({
          ...current,
          viewingRevision: revision,
        }));
      }
    });
  }

  /** Restores one immutable revision into the mutable draft and selects it. */
  async restoreRequestRevision(
    tabId: string,
    revisionId: string,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    await this.#runTab(tabId, async () => {
      const updated = await this.#webSocket.command<RequestView>(
        "request.revision.restore",
        {
          requestId: tab.request!.requestId,
          revisionId,
          expectedDraftRevision: tab.request!.draftRevision,
        },
      );
      const draft = requestToDraft(updated);
      this.#updateTab(tabId, (current) => ({
        ...current,
        request: updated,
        draft,
        baseline: cloneDraft(draft),
        viewingRevision: null,
      }));
      replaceLoadedRequestNode(updated);
      await this.#refreshRequestRevisions(tabId, updated.requestId);
    });
  }

  /** Executes an immutable revision without saving or replacing the draft. */
  async executeRequestRevision(
    tabId: string,
    revisionId: string,
  ): Promise<void> {
    const tab = requireTab(tabId);
    if (tab.request === null) return;
    await this.#runTab(tabId, async () => {
      const execution = await this.#webSocket.command<ExecutionView>(
        "execution.start_revision",
        { requestId: tab.request!.requestId, revisionId },
      );
      this.#updateTab(tabId, (current) =>
        withLiveExecution(current, execution),
      );
    });
  }

  /** Downloads one authorized response body while reporting shared failures. */
  async downloadExecutionBody(executionId: string): Promise<Blob> {
    return this.#run(() => this.session.downloadExecutionBody(executionId));
  }

  /** Runs one workspace-tree operation with shared busy and error state. */
  async #run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const store = useApplicationStore();
    store.busy = true;
    store.error = null;
    try {
      return await operation();
    } catch (cause) {
      store.error = applicationError(cause);
      throw cause;
    } finally {
      store.busy = false;
    }
  }

  /** Runs one tab operation without blocking unrelated request tabs. */
  async #runTab(tabId: string, operation: () => Promise<void>): Promise<void> {
    const store = useApplicationStore();
    store.error = null;
    this.#updateTab(tabId, (tab) => ({ ...tab, busy: true }));
    try {
      await operation();
    } catch (cause) {
      store.error = applicationError(cause);
      throw cause;
    } finally {
      this.#updateTab(tabId, (tab) => ({ ...tab, busy: false }));
    }
  }

  /** Opens a fully loaded saved request in a fresh active tab. */
  #openRequestTab(request: RequestView): string {
    const store = useApplicationStore();
    const draft = requestToDraft(request);
    const tab: RequestTab = {
      tabId: uuidV7(),
      workspaceId: request.workspaceId,
      request,
      draft,
      baseline: cloneDraft(draft),
      variableProfile: null,
      variableDraft: null,
      variableBaseline: null,
      pendingParentCollectionId: null,
      inheritedTarget: request.inheritedTarget,
      inheritedHeaders: request.inheritedHeaders.map((field) => ({
        ...field,
      })),
      capturedExchange: request.capturedExchange ?? null,
      execution: null,
      exchangeSummaries: [],
      selectedExchangeId: null,
      selectedExchange: null,
      revisions: [],
      viewingRevision: null,
      recoveryWarnings: [],
      busy: false,
    };
    store.requestTabs.push(tab);
    store.activeRequestTabId = tab.tabId;
    store.workbenchTabOrder.push(tab.tabId);
    store.activeWorkbenchTabId = tab.tabId;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
    return tab.tabId;
  }

  /** Adds one resource editor to the ordered workbench and activates it. */
  #appendResourceTab(tab: ResourceEditorTab): void {
    const store = useApplicationStore();
    store.resourceTabs.push(tab);
    store.workbenchTabOrder.push(tab.tabId);
    store.activeWorkbenchTabId = tab.tabId;
    store.activeRequestTabId = null;
  }

  /** Replaces one resource tab without permitting stale callbacks to recreate it. */
  #updateResourceTab(
    tabId: string,
    project: (tab: ResourceEditorTab) => ResourceEditorTab,
  ): void {
    const store = useApplicationStore();
    const index = store.resourceTabs.findIndex((tab) => tab.tabId === tabId);
    const tab = store.resourceTabs[index];
    if (tab !== undefined) store.resourceTabs[index] = project(tab);
  }

  /** Activates the last remaining tab visible in the selected workspace. */
  #activateNearestWorkbenchTab(): void {
    const store = useApplicationStore();
    const workspaceId = store.selectedWorkspaceId;
    const requestIds = new Set(
      store.requestTabs
        .filter((tab) => tab.workspaceId === workspaceId)
        .map((tab) => tab.tabId),
    );
    const resourceIds = new Set(
      store.resourceTabs
        .filter((tab) => tab.workspaceId === workspaceId)
        .map((tab) => tab.tabId),
    );
    const nextId = [...store.workbenchTabOrder]
      .reverse()
      .find((tabId) => requestIds.has(tabId) || resourceIds.has(tabId));
    store.activeWorkbenchTabId = nextId ?? null;
    store.activeRequestTabId =
      nextId !== undefined && requestIds.has(nextId) ? nextId : null;
  }

  /** Refreshes inherited request metadata without replacing editable drafts. */
  async #refreshOpenRequestContexts(workspaceId: string): Promise<void> {
    const store = useApplicationStore();
    const tabs = store.requestTabs.filter(
      (tab) => tab.workspaceId === workspaceId,
    );
    const requestIds = [
      ...new Set(
        tabs.flatMap((tab) =>
          tab.request === null ? [] : [tab.request.requestId],
        ),
      ),
    ];
    const temporaryCollectionIds = [
      ...new Set(
        tabs.flatMap((tab) =>
          tab.request === null && tab.pendingParentCollectionId !== null
            ? [tab.pendingParentCollectionId]
            : [],
        ),
      ),
    ];
    const selectedCollectionId =
      store.selectedWorkspaceId === workspaceId
        ? store.selectedCollectionId
        : null;
    const collectionIds = [
      ...new Set([
        ...temporaryCollectionIds,
        ...(selectedCollectionId === null ? [] : [selectedCollectionId]),
      ]),
    ];
    const [requests, collections] = await Promise.all([
      Promise.all(
        requestIds.map((requestId) =>
          this.#webSocket.command<RequestView>("request.get", { requestId }),
        ),
      ),
      Promise.all(
        collectionIds.map((collectionId) =>
          this.#webSocket.command<CollectionView>("collection.get", {
            collectionId,
          }),
        ),
      ),
    ]);
    const requestById = new Map(
      requests.map((request) => [request.requestId, request]),
    );
    const collectionById = new Map(
      collections.map((collection) => [collection.collectionId, collection]),
    );
    const workspace =
      store.selectedWorkspaceId === workspaceId
        ? store.selectedWorkspace
        : null;
    store.requestTabs = store.requestTabs.map((tab) => {
      if (tab.workspaceId !== workspaceId) return tab;
      if (tab.request !== null) {
        const request = requestById.get(tab.request.requestId);
        return request === undefined
          ? tab
          : {
              ...tab,
              request,
              inheritedTarget: request.inheritedTarget,
              inheritedHeaders: request.inheritedHeaders.map((field) => ({
                ...field,
              })),
            };
      }
      const collection =
        tab.pendingParentCollectionId === null
          ? null
          : (collectionById.get(tab.pendingParentCollectionId) ?? null);
      return {
        ...tab,
        inheritedTarget:
          collection === null
            ? (workspace?.baseUrl ?? tab.inheritedTarget)
            : joinTargetPreview(
                workspace?.baseUrl ?? "",
                collection.effectivePath,
              ),
        inheritedHeaders:
          collection === null
            ? (workspace?.headers.map((field) => ({ ...field })) ??
              tab.inheritedHeaders)
            : collection.effectiveHeaders.map((field) => ({ ...field })),
      };
    });
    if (selectedCollectionId !== null) {
      store.selectedCollection =
        collectionById.get(selectedCollectionId) ?? store.selectedCollection;
    }
  }

  /** Refreshes revision summaries without nesting request-tab busy state. */
  async #refreshRequestRevisions(
    tabId: string,
    requestId: string,
  ): Promise<void> {
    const result = await this.#webSocket.command<{
      revisions: RequestRevisionSummary[];
    }>("request.revision.list", { requestId });
    this.#updateTab(tabId, (current) => ({
      ...current,
      revisions: result.revisions,
    }));
  }

  /** Loads newest exchange summaries and the latest exchange detail. */
  async #loadRequestExchangeState(requestId: string): Promise<{
    exchangeSummaries: readonly RequestExchangeSummary[];
    selectedExchangeId: string | null;
    selectedExchange: RequestExchangeView | null;
  }> {
    const result = await this.#webSocket.command<RequestExchangeListView>(
      "request.exchange.list",
      { requestId },
    );
    const latest = result.exchanges[0];
    if (latest === undefined) {
      return {
        exchangeSummaries: [],
        selectedExchangeId: null,
        selectedExchange: null,
      };
    }
    const selectedExchange = await this.#webSocket.command<RequestExchangeView>(
      "request.exchange.get",
      {
        requestId,
        exchangeId: latest.exchangeId,
        kind: latest.kind,
      },
    );
    return {
      exchangeSummaries: result.exchanges,
      selectedExchangeId: latest.exchangeId,
      selectedExchange,
    };
  }

  /** Refreshes one open saved tab's exchange selector and latest detail. */
  async #refreshRequestExchanges(
    tabId: string,
    requestId: string,
  ): Promise<void> {
    const exchangeState = await this.#loadRequestExchangeState(requestId);
    this.#updateTab(tabId, (current) => ({ ...current, ...exchangeState }));
  }

  /** Replaces one tab through a mutation-safe state projection. */
  #updateTab(tabId: string, project: (tab: RequestTab) => RequestTab): void {
    const store = useApplicationStore();
    const index = store.requestTabs.findIndex((tab) => tab.tabId === tabId);
    const tab = store.requestTabs[index];
    if (tab !== undefined) {
      store.requestTabs[index] = project(tab);
    }
  }

  /** Routes asynchronous execution events to their owning request tab. */
  #applyExecutionEvent(type: string, payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      return;
    }
    const envelope = payload as {
      readonly executionId?: unknown;
      readonly data?: unknown;
    };
    if (typeof envelope.executionId !== "string") {
      return;
    }
    const store = useApplicationStore();
    const tab = store.requestTabs.find(
      (candidate) => candidate.execution?.executionId === envelope.executionId,
    );
    if (tab === undefined) {
      return;
    }
    const execution = tab.execution;
    if (execution === null) {
      return;
    }
    if (type === "execution.response_head") {
      const head = envelope.data as {
        readonly status: number;
        readonly headers: ExecutionView["headers"];
      };
      this.#updateLiveExecution(tab.tabId, {
        ...execution,
        status: head.status,
        ...(head.headers === undefined ? {} : { headers: head.headers }),
      });
    } else if (type === "execution.progress") {
      const progress = envelope.data as { readonly bodyBytes: number };
      this.#updateLiveExecution(tab.tabId, {
        ...execution,
        bodyBytes: progress.bodyBytes,
      });
    } else {
      this.#updateLiveExecution(tab.tabId, envelope.data as ExecutionView);
    }
  }

  /** Updates a live execution and its selected saved-history projection. */
  #updateLiveExecution(tabId: string, execution: ExecutionView): void {
    this.#updateTab(tabId, (current) =>
      current.request === null
        ? { ...current, execution }
        : withLiveExecution(current, execution, false),
    );
  }
}

/** Projects a saved live execution into history and optionally selects it. */
function withLiveExecution(
  tab: RequestTab,
  execution: ExecutionView,
  select = true,
): RequestTab {
  const existing = tab.exchangeSummaries.find(
    (summary) => summary.exchangeId === execution.executionId,
  );
  const summary: RequestExchangeSummary = {
    exchangeId: execution.executionId,
    requestId: tab.request!.requestId,
    requestRevisionId: existing?.requestRevisionId ?? null,
    kind: "execution",
    source: "apinteract",
    state: execution.state,
    ...(execution.status === undefined ? {} : { status: execution.status }),
    bodyAvailability:
      execution.bodyComplete === true
        ? "complete"
        : (execution.bodyBytes ?? 0) > 0
          ? "truncated"
          : "unavailable",
    occurredAt: existing?.occurredAt ?? execution.createdAt,
  };
  return {
    ...tab,
    execution,
    exchangeSummaries: [
      summary,
      ...tab.exchangeSummaries.filter(
        (candidate) => candidate.exchangeId !== execution.executionId,
      ),
    ],
    selectedExchangeId: select ? execution.executionId : tab.selectedExchangeId,
    selectedExchange:
      select || tab.selectedExchangeId === execution.executionId
        ? { summary, execution }
        : tab.selectedExchange,
  };
}

/** Projects workbench state into the versioned, secret-safe persistence shape. */
function localRequestSessionSnapshot(
  store: ReturnType<typeof useApplicationStore>,
): LocalRequestSessionSnapshot {
  return {
    selectedWorkspaceId: store.selectedWorkspaceId,
    activeRequestTabId: store.activeRequestTabId,
    activeWorkbenchTabId: store.activeWorkbenchTabId,
    workbenchTabOrder: [...store.workbenchTabOrder],
    tabs: store.requestTabs.map((tab): LocalRequestTabSnapshot => {
      const safeVariables = redactSecretVariableWrites(tab.variableDraft);
      const warnings = new Set<RequestRecoveryWarning>(
        tab.recoveryWarnings ?? [],
      );
      if (safeVariables.omittedSecretValues) {
        warnings.add("secrets-omitted");
      }
      const draftDirty =
        tab.baseline === null ||
        JSON.stringify(tab.draft) !== JSON.stringify(tab.baseline);
      const variableDirty =
        JSON.stringify(tab.variableDraft) !==
        JSON.stringify(tab.variableBaseline);
      return {
        tabId: tab.tabId,
        workspaceId: tab.workspaceId,
        requestId: tab.request?.requestId ?? null,
        baseDraftRevision: tab.request?.draftRevision ?? null,
        baseVariableRevision: tab.variableProfile?.revision ?? null,
        pendingParentCollectionId: tab.pendingParentCollectionId,
        draft: cloneDraft(tab.draft),
        draftDirty: isRequestTabDirty(tab) && draftDirty,
        variableDraft: safeVariables.variables,
        variableDirty: isRequestTabDirty(tab) && variableDirty,
        omittedSecretValues: safeVariables.omittedSecretValues,
        recoveryWarnings: [...warnings],
      };
    }),
    resourceTabs: store.resourceTabs.map(localResourceTabSnapshot),
  };
}

/** Projects one resource editor into a secret-safe browser payload. */
function localResourceTabSnapshot(
  tab: ResourceEditorTab,
): LocalResourceTabSnapshot {
  const safeVariables = redactSecretVariableWrites(tab.draft.variables);
  const common = {
    kind: tab.kind,
    tabId: tab.tabId,
    workspaceId: tab.workspaceId,
    omittedSecretValues: safeVariables.omittedSecretValues,
    dirty: isResourceEditorTabDirty(tab),
  } as const;
  if (tab.kind === "workspace") {
    return {
      ...common,
      kind: "workspace",
      resourceId: tab.workspace.workspaceId,
      baseRevision: tab.workspace.revision,
      baseVariableRevision: tab.variableProfile.revision,
      draft: {
        ...cloneWorkspacePropertiesDraft(tab.draft),
        variables: safeVariables.variables ?? [],
      },
    };
  }
  if (tab.kind === "collection") {
    return {
      ...common,
      kind: "collection",
      resourceId: tab.collection.collectionId,
      baseRevision: tab.collection.revision,
      baseVariableRevision: tab.variableProfile.revision,
      draft: {
        ...cloneCollectionPropertiesDraft(tab.draft),
        variables: safeVariables.variables ?? [],
      },
    };
  }
  return {
    ...common,
    kind: "environment",
    resourceId: tab.environment?.environmentId ?? null,
    baseRevision: tab.environment?.revision ?? null,
    baseVariableRevision: null,
    draft: {
      ...cloneEnvironmentDraft(tab.draft),
      variables: safeVariables.variables ?? [],
    },
  };
}

/** Reconstructs persistent recovery warnings without duplicating entries. */
function snapshotRecoveryWarnings(
  snapshot: LocalRequestTabSnapshot,
): RequestRecoveryWarning[] {
  const warnings = new Set(snapshot.recoveryWarnings);
  if (snapshot.omittedSecretValues) warnings.add("secrets-omitted");
  return [...warnings];
}

/** Returns a required selection or raises a user-facing workflow error. */
function requireSelection(value: string | null): string {
  if (value === null) {
    throw new WorkflowError("parentRequired");
  }
  return value;
}

/** Returns one open tab or raises a stale-interaction error. */
function requireTab(tabId: string): RequestTab {
  const tab = useApplicationStore().requestTabs.find(
    (candidate) => candidate.tabId === tabId,
  );
  if (tab === undefined) {
    throw new WorkflowError("requestTabClosed");
  }
  return tab;
}

/** Returns one resource editor of the requested kind or raises a stale-tab error. */
function requireResourceTab<Kind extends ResourceEditorTab["kind"]>(
  tabId: string,
  kind: Kind,
): Extract<ResourceEditorTab, { readonly kind: Kind }> {
  const tab = useApplicationStore().resourceTabs.find(
    (candidate) => candidate.tabId === tabId && candidate.kind === kind,
  );
  if (tab === undefined) throw new WorkflowError("requestTabClosed");
  return tab as Extract<ResourceEditorTab, { readonly kind: Kind }>;
}

/** Returns the currently active request tab. */
function activeRequestTab(store: {
  readonly requestTabs: readonly RequestTab[];
  readonly activeRequestTabId: string | null;
}): RequestTab | null {
  return (
    store.requestTabs.find((tab) => tab.tabId === store.activeRequestTabId) ??
    null
  );
}

/** Creates editable request content with a context-appropriate target mode. */
function emptyDraft(
  targetMode: RequestDraftInput["targetMode"],
): RequestDraftInput {
  return {
    name: "",
    method: "GET",
    targetMode,
    targetUrl: "",
    query: [],
    headers: [],
    requestBody: { kind: "none" },
    body: "",
    preRequestScript: "",
    postResponseScript: "",
  };
}

/** Projects a saved backend request onto editable tab content. */
function requestToDraft(request: RequestView): RequestDraftInput {
  const requestBody =
    request.requestBody ??
    (request.body === ""
      ? { kind: "none" as const }
      : { kind: "text" as const, contentType: null, text: request.body });
  return {
    name: request.name,
    method: request.method,
    targetMode: request.targetMode,
    targetUrl: request.targetUrl,
    query: request.query.map((field) => ({ ...field })),
    headers: request.headers.map((field) => ({ ...field })),
    requestBody: cloneRequestBody(requestBody),
    body: requestBody.kind === "text" ? request.body : "",
    preRequestScript: request.preRequestScript,
    postResponseScript: request.postResponseScript,
  };
}

/** Clones editable request content without sharing nested field objects. */
function cloneDraft(draft: RequestDraftInput): RequestDraftInput {
  return {
    ...draft,
    ...(draft.requestBody === undefined
      ? {}
      : { requestBody: cloneRequestBody(draft.requestBody) }),
    query: draft.query.map((field) => ({ ...field })),
    headers: draft.headers.map((field) => ({ ...field })),
  };
}

/** Clones semantic body definitions, including ordered structured form fields. */
function cloneRequestBody(body: RequestBodyDefinition): RequestBodyDefinition {
  if (body.kind === "file") {
    return { ...body, attachment: { ...body.attachment } };
  }
  if (body.kind === "urlencoded") {
    return { ...body, fields: body.fields.map((field) => ({ ...field })) };
  }
  if (body.kind === "multipart") {
    return {
      ...body,
      fields: body.fields.map((field) =>
        "kind" in field && field.kind === "file"
          ? { ...field, attachment: { ...field.attachment } }
          : { ...field },
      ),
    };
  }
  return { ...body };
}

/** Converts a redacted profile into a write-safe editable baseline. */
function variableViewsToWrites(
  variables: VariableProfileView["variables"],
): VariableWrite[] {
  return variables.map((variable) => {
    const common = { variableId: variable.variableId, name: variable.name };
    switch (variable.kind) {
      case "value":
        return { ...common, kind: "value", value: variable.value };
      case "alias":
        return { ...common, kind: "alias", target: variable.target };
      case "unset":
        return { ...common, kind: "unset" };
      case "secret":
        return { ...common, kind: "secret" };
    }
  });
}

/** Clones variable writes without sharing mutable command objects. */
function cloneVariableWrites(
  variables: readonly VariableWrite[],
): VariableWrite[] {
  return variables.map((variable) => ({ ...variable }));
}

/** Projects workspace properties and redacted variables onto editable content. */
function workspacePropertiesDraft(
  workspace: WorkspaceView,
  profile: VariableProfileView,
): WorkspacePropertiesDraft {
  return {
    name: workspace.name,
    baseUrl: workspace.baseUrl,
    headers: workspace.headers.map((header) => ({ ...header })),
    variables: variableViewsToWrites(profile.variables),
  };
}

/** Clones a workspace editor draft without sharing mutable field objects. */
function cloneWorkspacePropertiesDraft(
  draft: WorkspacePropertiesDraft,
): WorkspacePropertiesDraft {
  return {
    ...draft,
    headers: draft.headers.map((header) => ({ ...header })),
    variables: cloneVariableWrites(draft.variables),
  };
}

/** Projects collection properties and redacted variables onto editable content. */
function collectionPropertiesDraft(
  collection: CollectionView,
  profile: VariableProfileView,
): CollectionPropertiesDraft {
  return {
    name: collection.name,
    pathPrefix: collection.pathPrefix,
    headers: collection.headers.map((header) => ({ ...header })),
    variables: variableViewsToWrites(profile.variables),
  };
}

/** Clones a collection editor draft without sharing mutable field objects. */
function cloneCollectionPropertiesDraft(
  draft: CollectionPropertiesDraft,
): CollectionPropertiesDraft {
  return {
    ...draft,
    headers: draft.headers.map((header) => ({ ...header })),
    variables: cloneVariableWrites(draft.variables),
  };
}

/** Projects one redacted environment onto editable content. */
function environmentDraft(environment: EnvironmentView): EnvironmentDraft {
  return {
    name: environment.name,
    variables: environment.variables.map((variable) => {
      const common = { variableId: variable.variableId, name: variable.name };
      switch (variable.kind) {
        case "value":
          return { ...common, kind: "value" as const, value: variable.value };
        case "alias":
          return { ...common, kind: "alias" as const, target: variable.target };
        case "unset":
          return { ...common, kind: "unset" as const };
        case "secret":
          return { ...common, kind: "secret" as const };
      }
    }),
    includedEnvironmentIds: environment.includedEnvironments.map(
      (included) => included.environmentId,
    ),
  };
}

/** Clones an environment editor draft without sharing mutation payloads. */
function cloneEnvironmentDraft(draft: EnvironmentDraft): EnvironmentDraft {
  return {
    name: draft.name,
    variables: draft.variables.map((variable) => ({ ...variable })),
    includedEnvironmentIds: [...draft.includedEnvironmentIds],
  };
}

/** Returns the display name used for one unsaved request-variable source. */
function temporaryVariableScopeName(tab: RequestTab): string {
  return tab.draft.name.trim() || "Temporary request";
}

/** Projects one tab's local variables onto the temporary backend contract. */
function temporaryVariableProfile(
  tab: RequestTab,
): TemporaryRequestVariableProfile {
  return {
    scopeId: tab.tabId,
    scopeName: temporaryVariableScopeName(tab),
    variables: cloneVariableWrites(tab.variableDraft ?? []),
  };
}

/** Returns imported collections from the root to one request's nearest parent. */
function importedCollectionChain(
  plan: ImportPlan,
  request: ImportedRequest,
): ImportPlan["collections"] {
  const collectionByKey = new Map(
    plan.collections.map((collection) => [
      collection.collectionKey,
      collection,
    ]),
  );
  const reversed: ImportPlan["collections"][number][] = [];
  const visited = new Set<string>();
  let key = request.collectionKey;
  while (key !== null && !visited.has(key)) {
    visited.add(key);
    const collection = collectionByKey.get(key);
    if (collection === undefined) break;
    reversed.push(collection);
    key = collection.parentCollectionKey;
  }
  return reversed.reverse();
}

/** Flattens inherited imported variables with nearer declarations overriding by name. */
function mergeImportedVariables(
  profiles: readonly (readonly VariableWrite[])[],
): VariableWrite[] {
  const merged: VariableWrite[] = [];
  const indexByName = new Map<string, number>();
  for (const profile of profiles) {
    for (const variable of profile) {
      const index = indexByName.get(variable.name);
      if (index === undefined) {
        indexByName.set(variable.name, merged.length);
        merged.push(variable);
      } else {
        merged[index] = variable;
      }
    }
  }
  return merged;
}

/** Joins an inherited target and local path across a single slash boundary. */
function joinTargetPreview(prefix: string, path: string): string {
  if (prefix === "") return path;
  if (path === "") return prefix;
  return `${prefix.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** Removes the editor-only name from a temporary execution snapshot. */
function executableDraft(draft: RequestDraftInput) {
  const requestBody =
    draft.requestBody ??
    (draft.body === ""
      ? { kind: "none" as const }
      : { kind: "text" as const, contentType: null, text: draft.body });
  return {
    method: draft.method,
    targetMode: draft.targetMode,
    targetUrl: draft.targetUrl,
    query: draft.query,
    headers: draft.headers,
    requestBody,
    body: requestBody.kind === "text" ? requestBody.text : "",
    preRequestScript: draft.preRequestScript,
    postResponseScript: draft.postResponseScript,
  };
}

/** Returns an array containing the value exactly once. */
function includeOnce(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

/** Collects every currently loaded collection and request beneath one collection. */
function loadedCollectionSubtree(
  rootCollectionId: string,
  children: Readonly<Record<string, readonly TreeNode[]>>,
): {
  readonly collectionIds: ReadonlySet<string>;
  readonly requestIds: ReadonlySet<string>;
} {
  const collectionIds = new Set([rootCollectionId]);
  const requestIds = new Set<string>();
  const pending = [rootCollectionId];
  for (let index = 0; index < pending.length; index += 1) {
    const collectionId = pending[index];
    if (collectionId === undefined) continue;
    for (const node of children[collectionId] ?? []) {
      if (node.kind === "collection") {
        if (!collectionIds.has(node.nodeId)) {
          collectionIds.add(node.nodeId);
          pending.push(node.nodeId);
        }
      } else {
        requestIds.add(node.nodeId);
      }
    }
  }
  return { collectionIds, requestIds };
}

/** Updates request labels and methods in every loaded tree branch. */
function replaceLoadedRequestNode(request: RequestView): void {
  const store = useApplicationStore();
  store.rootNodes = replaceRequestNode(store.rootNodes, request);
  store.collectionChildren = Object.fromEntries(
    Object.entries(store.collectionChildren).map(([collectionId, nodes]) => [
      collectionId,
      replaceRequestNode(nodes, request),
    ]),
  );
}

/** Updates one request label and method in a loaded child list. */
function replaceRequestNode(
  nodes: readonly TreeNode[],
  request: RequestView,
): TreeNode[] {
  return nodes.map((node) =>
    node.nodeId === request.requestId
      ? { ...node, name: request.name, method: request.method }
      : node,
  );
}

/** Maps an operation failure to a localizable code or backend fallback text. */
function applicationError(cause: unknown): ApplicationError {
  if (cause instanceof WorkflowError) {
    return { code: cause.code, message: null };
  }
  return cause instanceof Error
    ? { code: null, message: cause.message }
    : { code: "operationFailed", message: null };
}
