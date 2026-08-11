import { v7 as uuidV7 } from "uuid";

import type {
  CollectionView,
  EnvironmentListView,
  EnvironmentVariableWrite,
  EnvironmentView,
  ExecutionView,
  RequestField,
  RequestView,
  TreeNode,
  EditableVariableScopeKind,
  VariableProfileView,
  VariablePreviewResult,
  VariableWrite,
  WorkspaceSummary,
  WorkspaceView,
} from "@/model/contracts/backend";
import { useApplicationStore } from "@/control/state/application-store";
import type { SessionController } from "@/control/session/session-controller";
import type { BackendWebSocketClient } from "@/control/transport/websocket-client";
import type {
  ApplicationError,
  ApplicationErrorCode,
  RequestDraftInput,
  RequestTab,
} from "@/model/domain/application";

class WorkflowError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    super(code);
    this.code = code;
  }
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
  #previewNames: readonly string[] = [];
  #previewSequence = 0;

  constructor(session: SessionController, webSocket: BackendWebSocketClient) {
    this.session = session;
    this.#webSocket = webSocket;
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

  /** Loads visible workspaces and selects the first available workspace. */
  async initializeWorkspace(): Promise<void> {
    await this.#run(async () => {
      const result = await this.#webSocket.command<{
        workspaces: WorkspaceSummary[];
      }>("workspace.list", {});
      const store = useApplicationStore();
      store.workspaces = result.workspaces;
      const first = result.workspaces[0];
      if (first !== undefined) {
        await this.#selectWorkspace(first.workspaceId);
      }
    });
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

  /** Selects a workspace and loads its root tree. */
  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.#run(() => this.#selectWorkspace(workspaceId));
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
    this.#previewSequence += 1;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
    store.collectionChildren = {};
    store.expandedCollectionIds = [];
    const active = activeRequestTab(store);
    if (active !== null && active.workspaceId !== workspaceId) {
      store.activeRequestTabId =
        store.requestTabs.find((tab) => tab.workspaceId === workspaceId)
          ?.tabId ?? null;
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

  /** Saves workspace properties and variables as one coordinated UI action. */
  async updateWorkspaceProperties(
    workspaceId: string,
    expectedRevision: number,
    name: string,
    headers: readonly RequestField[],
    expectedVariableRevision: number,
    variables: readonly VariableWrite[],
  ): Promise<void> {
    await this.#run(async () => {
      const workspace = await this.#webSocket.command<WorkspaceView>(
        "workspace.update",
        { workspaceId, expectedRevision, name, headers },
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
      await this.#refreshVariablePreviews();
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
      store.activeRequestTabId = null;
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

  /** Refreshes redacted resolution hints without blocking request editing. */
  async previewVariables(names: readonly string[]): Promise<void> {
    this.#previewNames = [...new Set(names)].slice(0, 100);
    await this.#refreshVariablePreviews();
  }

  /** Applies only the newest best-effort preview response for active context. */
  async #refreshVariablePreviews(): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = store.selectedWorkspaceId;
    const names = this.#previewNames;
    const sequence = ++this.#previewSequence;
    if (workspaceId === null || names.length === 0) {
      store.variablePreviews = [];
      return;
    }
    try {
      const result = await this.#webSocket.command<VariablePreviewResult>(
        "variable.preview",
        {
          workspaceId,
          parentCollectionId:
            activeRequestTab(store)?.request?.parentCollectionId ??
            activeRequestTab(store)?.pendingParentCollectionId ??
            null,
          requestId: activeRequestTab(store)?.request?.requestId ?? null,
          names,
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
      useApplicationStore().selectedVariableProfile = profile;
      return profile;
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
  ): Promise<EnvironmentView> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    return this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.create",
        { workspaceId, name, variables },
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
  ): Promise<EnvironmentView> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    return this.#run(async () => {
      const environment = await this.#webSocket.command<EnvironmentView>(
        "environment.update",
        { environmentId, expectedRevision, name, variables },
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
    store.expandedCollectionIds = includeOnce(
      store.expandedCollectionIds,
      collectionId,
    );
  }

  /** Saves a collection's name, headers, and variable profile as one UI operation. */
  async updateCollectionProperties(
    collectionId: string,
    expectedRevision: number,
    name: string,
    headers: readonly RequestField[],
    expectedVariableRevision: number,
    variables: readonly VariableWrite[],
  ): Promise<void> {
    await this.#run(async () => {
      const collection = await this.#webSocket.command<CollectionView>(
        "collection.update",
        { collectionId, expectedRevision, name, headers },
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
      await this.#refreshVariablePreviews();
    });
  }

  /** Deletes a collection subtree and removes its loaded tabs and navigation state. */
  async deleteCollection(
    collectionId: string,
    expectedRevision: number,
  ): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    const collection = store.selectedCollection;
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
      if (
        !store.requestTabs.some((tab) => tab.tabId === store.activeRequestTabId)
      ) {
        store.activeRequestTabId = null;
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
      draft: emptyDraft(),
      baseline: null,
      pendingParentCollectionId: parentCollectionId,
      inheritedHeaders:
        parentCollectionId === null
          ? (store.selectedWorkspace?.headers.map((field) => ({ ...field })) ??
            [])
          : store.selectedCollectionId === parentCollectionId
            ? (store.selectedCollection?.effectiveHeaders.map((field) => ({
                ...field,
              })) ?? [])
            : [],
      execution: null,
      busy: false,
    };
    store.requestTabs.push(tab);
    store.activeRequestTabId = tab.tabId;
    store.selectedCollectionId = null;
    store.selectedCollection = null;
  }

  /** Activates an already open request tab. */
  activateRequestTab(tabId: string): void {
    const store = useApplicationStore();
    if (store.requestTabs.some((tab) => tab.tabId === tabId)) {
      store.activeRequestTabId = tabId;
      store.selectedCollectionId = null;
      store.selectedCollection = null;
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
    if (store.activeRequestTabId === tabId) {
      store.activeRequestTabId =
        store.requestTabs[index]?.tabId ??
        store.requestTabs[index - 1]?.tabId ??
        null;
    }
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
      const draft = requestToDraft(request);
      const tab: RequestTab = {
        tabId: uuidV7(),
        workspaceId: request.workspaceId,
        request,
        draft,
        baseline: cloneDraft(draft),
        pendingParentCollectionId: null,
        inheritedHeaders: request.inheritedHeaders.map((field) => ({
          ...field,
        })),
        execution: null,
        busy: false,
      };
      store.requestTabs.push(tab);
      store.activeRequestTabId = tab.tabId;
      store.selectedCollectionId = null;
      store.selectedCollection = null;
    });
  }

  /** Replaces editable content for one open request tab. */
  updateRequestDraft(tabId: string, draft: RequestDraftInput): void {
    this.#updateTab(tabId, (tab) => ({ ...tab, draft: cloneDraft(draft) }));
  }

  /** Persists edits for one already saved request tab. */
  async saveRequest(tabId: string, draft: RequestDraftInput): Promise<void> {
    this.updateRequestDraft(tabId, draft);
    const tab = requireTab(tabId);
    if (tab.request === null) {
      return;
    }
    await this.#runTab(tabId, async () => {
      const updated = await this.#webSocket.command<RequestView>(
        "request.update",
        {
          requestId: tab.request?.requestId,
          expectedDraftRevision: tab.request?.draftRevision,
          ...draft,
        },
      );
      const savedDraft = requestToDraft(updated);
      this.#updateTab(tabId, (current) => ({
        ...current,
        request: updated,
        draft: savedDraft,
        baseline: cloneDraft(savedDraft),
      }));
      replaceLoadedRequestNode(updated);
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
          ...tab.draft,
          name,
        },
      );
      const savedDraft = requestToDraft(request);
      this.#updateTab(tabId, (current) => ({
        ...current,
        request,
        draft: savedDraft,
        baseline: cloneDraft(savedDraft),
        pendingParentCollectionId: null,
        inheritedHeaders: request.inheritedHeaders.map((field) => ({
          ...field,
        })),
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
              },
            )
          : await this.#webSocket.command<ExecutionView>("execution.start", {
              requestId: tab.request.requestId,
            });
      this.#updateTab(tabId, (current) => ({
        ...current,
        execution,
      }));
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
      this.#updateTab(tab.tabId, (current) => ({
        ...current,
        execution: {
          ...execution,
          status: head.status,
          ...(head.headers === undefined ? {} : { headers: head.headers }),
        },
      }));
    } else if (type === "execution.progress") {
      const progress = envelope.data as { readonly bodyBytes: number };
      this.#updateTab(tab.tabId, (current) => ({
        ...current,
        execution: { ...execution, bodyBytes: progress.bodyBytes },
      }));
    } else {
      this.#updateTab(tab.tabId, (current) => ({
        ...current,
        execution: envelope.data as ExecutionView,
      }));
    }
  }
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

/** Creates the initial editable content for a temporary request. */
function emptyDraft(): RequestDraftInput {
  return {
    name: "",
    method: "GET",
    targetUrl: "",
    query: [],
    headers: [],
    body: "",
    preRequestScript: "",
    postResponseScript: "",
  };
}

/** Projects a saved backend request onto editable tab content. */
function requestToDraft(request: RequestView): RequestDraftInput {
  return {
    name: request.name,
    method: request.method,
    targetUrl: request.targetUrl,
    query: request.query.map((field) => ({ ...field })),
    headers: request.headers.map((field) => ({ ...field })),
    body: request.body,
    preRequestScript: request.preRequestScript,
    postResponseScript: request.postResponseScript,
  };
}

/** Clones editable request content without sharing nested field objects. */
function cloneDraft(draft: RequestDraftInput): RequestDraftInput {
  return {
    ...draft,
    query: draft.query.map((field) => ({ ...field })),
    headers: draft.headers.map((field) => ({ ...field })),
  };
}

/** Removes the editor-only name from a temporary execution snapshot. */
function executableDraft(draft: RequestDraftInput) {
  return {
    method: draft.method,
    targetUrl: draft.targetUrl,
    query: draft.query,
    headers: draft.headers,
    body: draft.body,
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
