import type {
  CurrentSession,
  ExecutionView,
  RequestView,
  TreeNode,
  WorkspaceSummary,
} from "../contracts/backend";

export type ConnectionState = "disconnected" | "connecting" | "authenticated";

export interface ApplicationSnapshot {
  readonly session: CurrentSession | null;
  readonly connection: ConnectionState;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly rootNodes: readonly TreeNode[];
  readonly selectedCollectionId: string | null;
  readonly collectionNodes: readonly TreeNode[];
  readonly request: RequestView | null;
  readonly execution: ExecutionView | null;
  readonly busy: boolean;
  readonly error: string | null;
}
