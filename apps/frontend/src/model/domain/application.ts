import type {
  CollectionView,
  CurrentSession,
  ExecutionView,
  HttpMethod,
  RequestField,
  RequestRevisionSummary,
  RequestRevisionView,
  RequestView,
  TreeNode,
  WorkspaceSummary,
} from "../contracts/backend";

export type ConnectionState = "disconnected" | "connecting" | "authenticated";

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
  readonly method: HttpMethod;
  readonly targetUrl: string;
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
}

export interface RequestTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly request: RequestView | null;
  readonly draft: RequestDraftInput;
  readonly baseline: RequestDraftInput | null;
  readonly pendingParentCollectionId: string | null;
  readonly inheritedHeaders: readonly RequestField[];
  readonly execution: ExecutionView | null;
  readonly revisions: readonly RequestRevisionSummary[];
  readonly viewingRevision: RequestRevisionView | null;
  readonly busy: boolean;
}

/** Reports whether a tab contains content not represented by its saved baseline. */
export function isRequestTabDirty(tab: RequestTab): boolean {
  return (
    tab.baseline === null ||
    JSON.stringify(tab.draft) !== JSON.stringify(tab.baseline)
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
  readonly busy: boolean;
  readonly error: ApplicationError | null;
}
