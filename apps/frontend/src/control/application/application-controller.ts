import type {
  ExecutionView,
  RequestView,
  TreeNode,
  WorkspaceSummary,
} from "@/model/contracts/backend";
import { useApplicationStore } from "@/control/state/application-store";
import type { SessionController } from "@/control/session/session-controller";
import type { BackendWebSocketClient } from "@/control/transport/websocket-client";
import type { RequestDraftInput } from "@/model/domain/application";

/**
 * Coordinates backend commands with application view state.
 *
 * The controller owns workflow sequencing and user-facing busy/error state. It
 * does not enforce authorization or duplicate backend domain rules.
 */
export class ApplicationController {
  readonly session: SessionController;
  readonly #webSocket: BackendWebSocketClient;

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

  /** Selects a workspace and resets all descendant view state. */
  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.#run(() => this.#selectWorkspace(workspaceId));
  }

  /** Loads a workspace root without creating a nested foreground operation. */
  async #selectWorkspace(workspaceId: string): Promise<void> {
    const result = await this.#webSocket.command<{ children: TreeNode[] }>(
      "tree.list",
      { workspaceId, parentCollectionId: null },
    );
    const store = useApplicationStore();
    store.selectedWorkspaceId = workspaceId;
    store.rootNodes = result.children;
    store.selectedCollectionId = null;
    store.collectionChildren = {};
    store.expandedCollectionIds = [];
    store.request = null;
    store.execution = null;
  }

  /** Creates a collection under the workspace root or a selected collection. */
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
      const result = await this.#webSocket.command<{ children: TreeNode[] }>(
        "tree.list",
        { workspaceId, parentCollectionId },
      );
      if (parentCollectionId === null) {
        store.rootNodes = result.children;
      } else {
        store.collectionChildren = {
          ...store.collectionChildren,
          [parentCollectionId]: result.children,
        };
        store.selectedCollectionId = parentCollectionId;
        store.expandedCollectionIds = includeOnce(
          store.expandedCollectionIds,
          parentCollectionId,
        );
        store.request = null;
        store.execution = null;
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
    const result = await this.#webSocket.command<{ children: TreeNode[] }>(
      "tree.list",
      { workspaceId, parentCollectionId: collectionId },
    );
    store.selectedCollectionId = collectionId;
    store.collectionChildren = {
      ...store.collectionChildren,
      [collectionId]: result.children,
    };
    store.expandedCollectionIds = includeOnce(
      store.expandedCollectionIds,
      collectionId,
    );
    store.request = null;
    store.execution = null;
  }

  /** Expands an unloaded collection or collapses its currently visible branch. */
  async toggleCollection(collectionId: string): Promise<void> {
    const store = useApplicationStore();
    if (store.expandedCollectionIds.includes(collectionId)) {
      store.expandedCollectionIds = store.expandedCollectionIds.filter(
        (candidate) => candidate !== collectionId,
      );
      return;
    }
    await this.selectCollection(collectionId);
  }

  /** Creates and selects a request under the current collection. */
  async createRequest(name: string, targetUrl: string): Promise<void> {
    const store = useApplicationStore();
    const workspaceId = requireSelection(store.selectedWorkspaceId);
    const collectionId = requireSelection(store.selectedCollectionId);
    await this.#run(async () => {
      const request = await this.#webSocket.command<RequestView>(
        "request.create",
        {
          workspaceId,
          parentCollectionId: collectionId,
          name,
          targetUrl,
        },
      );
      await this.#selectCollection(collectionId);
      store.request = request;
      store.selectedCollectionId = null;
    });
  }

  /** Loads a selected request draft and clears any previous execution view. */
  async selectRequest(requestId: string): Promise<void> {
    await this.#run(async () => {
      const store = useApplicationStore();
      store.request = await this.#webSocket.command<RequestView>(
        "request.get",
        { requestId },
      );
      store.selectedCollectionId = null;
      store.execution = null;
    });
  }

  /** Persists current request edits using optimistic draft revision matching. */
  async saveRequest(draft: RequestDraftInput): Promise<void> {
    const store = useApplicationStore();
    const request = store.request;
    if (request === null) {
      return;
    }
    await this.#run(async () => {
      const updated = await this.#webSocket.command<RequestView>(
        "request.update",
        {
          requestId: request.requestId,
          expectedDraftRevision: request.draftRevision,
          ...draft,
        },
      );
      store.request = updated;
      store.rootNodes = replaceRequestNode(store.rootNodes, updated);
      store.collectionChildren = Object.fromEntries(
        Object.entries(store.collectionChildren).map(
          ([collectionId, nodes]) => [
            collectionId,
            replaceRequestNode(nodes, updated),
          ],
        ),
      );
    });
  }

  /** Saves current edits and starts execution from the persisted request. */
  async executeRequest(draft: RequestDraftInput): Promise<void> {
    // Execution always uses the latest persisted draft. The backend creates an
    // immutable execution revision only when that draft differs.
    await this.saveRequest(draft);
    const store = useApplicationStore();
    if (store.request === null) {
      return;
    }
    await this.#run(async () => {
      store.execution = await this.#webSocket.command<ExecutionView>(
        "execution.start",
        { requestId: store.request?.requestId },
      );
    });
  }

  /** Runs one foreground operation while maintaining shared busy/error state. */
  async #run(operation: () => Promise<void>): Promise<void> {
    // Quick verification exposes one foreground operation at a time, so one
    // application-level busy flag represents the complete interaction state.
    const store = useApplicationStore();
    store.busy = true;
    store.error = null;
    try {
      await operation();
    } catch (cause) {
      store.error =
        cause instanceof Error ? cause.message : "The operation failed.";
      throw cause;
    } finally {
      store.busy = false;
    }
  }

  /** Merges asynchronous execution events into the active response view. */
  #applyExecutionEvent(type: string, payload: unknown): void {
    const store = useApplicationStore();
    if (
      store.execution === null ||
      typeof payload !== "object" ||
      payload === null
    ) {
      return;
    }
    if (type === "execution.response_head") {
      const head = payload as {
        readonly status: number;
        readonly headers: ExecutionView["headers"];
      };
      store.execution = {
        ...store.execution,
        status: head.status,
        ...(head.headers === undefined ? {} : { headers: head.headers }),
      };
    } else if (type === "execution.progress") {
      const progress = payload as { readonly bodyBytes: number };
      store.execution = { ...store.execution, bodyBytes: progress.bodyBytes };
    } else {
      store.execution = payload as ExecutionView;
    }
  }
}

/** Returns a required selection or raises a user-facing workflow error. */
function requireSelection(value: string | null): string {
  if (value === null) {
    throw new Error("Select the required parent first.");
  }
  return value;
}

/** Returns an array containing the value exactly once. */
function includeOnce(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

/** Updates request labels and methods in every loaded tree branch. */
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
