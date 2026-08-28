import type {
  CollectionView,
  CapturedExchangeView,
  CurrentSession,
  EnvironmentVariableWrite,
  EnvironmentView,
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestBodyDefinition,
  RequestExchangeSummary,
  RequestExchangeView,
  RequestRevisionSummary,
  RequestRevisionView,
  RequestView,
  TreeNode,
  VariableProfileView,
  VariableWrite,
  WorkspaceView,
  WorkspaceSummary,
} from "../contracts/backend";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticated"
  | "offline"
  | "reconnecting";

export type ApplicationErrorCode =
  | "operationFailed"
  | "parentRequired"
  | "requestTabClosed";

export interface ApplicationError {
  readonly code: ApplicationErrorCode | null;
  readonly message: string | null;
}

export interface RequestDraftInput {
  readonly name: string;
  readonly description?: string;
  readonly notes?: string;
  readonly method: HttpMethod;
  readonly targetMode: "absolute" | "composed";
  readonly targetUrl: string;
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  /** Preferred semantic body shape; legacy drafts may omit it. */
  readonly requestBody?: RequestBodyDefinition;
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
}

export type RequestRecoveryWarning = "stale" | "secrets-omitted";

export interface RequestTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly request: RequestView | null;
  readonly draft: RequestDraftInput;
  readonly baseline: RequestDraftInput | null;
  readonly variableProfile: VariableProfileView | null;
  readonly variableDraft: readonly VariableWrite[] | null;
  readonly variableBaseline: readonly VariableWrite[] | null;
  readonly pendingParentCollectionId: string | null;
  readonly inheritedTarget: string;
  readonly inheritedHeaders: readonly RequestField[];
  readonly capturedExchange?: CapturedExchangeView | null;
  readonly execution: ExecutionView | null;
  readonly exchangeSummaries: readonly RequestExchangeSummary[];
  readonly selectedExchangeId: string | null;
  readonly selectedExchange: RequestExchangeView | null;
  readonly revisions: readonly RequestRevisionSummary[];
  readonly viewingRevision: RequestRevisionView | null;
  readonly recoveryWarnings?: readonly RequestRecoveryWarning[];
  readonly busy: boolean;
}

export interface WorkspacePropertiesDraft {
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly baseUrl: string;
  readonly headers: readonly RequestField[];
  readonly variables: readonly VariableWrite[];
}

export interface CollectionPropertiesDraft {
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly pathPrefix: string;
  readonly headers: readonly RequestField[];
  readonly variables: readonly VariableWrite[];
}

export interface EnvironmentDraft {
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly variables: readonly EnvironmentVariableWrite[];
  readonly includedEnvironmentIds: readonly string[];
}

interface ResourceEditorTabBase {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly busy: boolean;
  readonly omittedSecretValues?: boolean;
}

export interface WorkspacePropertiesTab extends ResourceEditorTabBase {
  readonly kind: "workspace";
  readonly workspace: WorkspaceView;
  readonly variableProfile: VariableProfileView;
  readonly draft: WorkspacePropertiesDraft;
  readonly baseline: WorkspacePropertiesDraft;
}

export interface CollectionPropertiesTab extends ResourceEditorTabBase {
  readonly kind: "collection";
  readonly collection: CollectionView;
  readonly variableProfile: VariableProfileView;
  readonly draft: CollectionPropertiesDraft;
  readonly baseline: CollectionPropertiesDraft;
}

export interface EnvironmentEditorTab extends ResourceEditorTabBase {
  readonly kind: "environment";
  readonly environment: EnvironmentView | null;
  readonly draft: EnvironmentDraft;
  readonly baseline: EnvironmentDraft | null;
}

export type ResourceEditorTab =
  | WorkspacePropertiesTab
  | CollectionPropertiesTab
  | EnvironmentEditorTab;

export type WorkbenchTab =
  | { readonly kind: "request"; readonly requestTab: RequestTab }
  | ResourceEditorTab;

export interface WorkbenchTabNameFallbacks {
  readonly untitledRequest: string;
  readonly createEnvironment: string;
}

/** Reports whether a resource editor differs from its last persisted baseline. */
export function isResourceEditorTabDirty(tab: ResourceEditorTab): boolean {
  return (
    tab.baseline === null ||
    JSON.stringify(tab.draft) !== JSON.stringify(tab.baseline)
  );
}

/** Returns the stable identity of any workbench tab variant. */
export function workbenchTabId(tab: WorkbenchTab): string {
  return tab.kind === "request" ? tab.requestTab.tabId : tab.tabId;
}

/** Returns the workspace owning any workbench tab variant. */
export function workbenchTabWorkspaceId(tab: WorkbenchTab): string {
  return tab.kind === "request" ? tab.requestTab.workspaceId : tab.workspaceId;
}

/** Returns the user-authored or supplied fallback name for any workbench tab. */
export function workbenchTabName(
  tab: WorkbenchTab,
  fallbacks: WorkbenchTabNameFallbacks,
): string {
  if (tab.kind === "request") {
    return tab.requestTab.draft.name.trim() || fallbacks.untitledRequest;
  }
  if (tab.kind === "environment") {
    return tab.draft.name.trim() || fallbacks.createEnvironment;
  }
  return tab.draft.name.trim();
}

/** Reports whether any workbench tab contains unsaved editable content. */
export function isWorkbenchTabDirty(tab: WorkbenchTab): boolean {
  return tab.kind === "request"
    ? isRequestTabDirty(tab.requestTab)
    : isResourceEditorTabDirty(tab);
}

/** Reports whether a tab contains content not represented by its saved baseline. */
export function isRequestTabDirty(tab: RequestTab): boolean {
  return (
    tab.baseline === null ||
    JSON.stringify(tab.draft) !== JSON.stringify(tab.baseline) ||
    JSON.stringify(tab.variableDraft) !== JSON.stringify(tab.variableBaseline)
  );
}

export interface ApplicationSnapshot {
  readonly session: CurrentSession | null;
  readonly connection: ConnectionState;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly rootNodes: readonly TreeNode[];
  readonly selectedCollectionId: string | null;
  readonly selectedCollection: CollectionView | null;
  readonly collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  readonly expandedCollectionIds: readonly string[];
  readonly requestTabs: readonly RequestTab[];
  readonly activeRequestTabId: string | null;
  readonly resourceTabs: readonly ResourceEditorTab[];
  readonly workbenchTabOrder: readonly string[];
  readonly activeWorkbenchTabId: string | null;
  readonly busy: boolean;
  readonly error: ApplicationError | null;
}
