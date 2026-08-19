import { defineStore } from "pinia";

import type {
  CollectionView,
  CurrentSession,
  EnvironmentSummary,
  EnvironmentView,
  TreeNode,
  VariableProfileView,
  VariablePreview,
  WorkspaceSummary,
  WorkspaceView,
} from "@/model/contracts/backend";
import type {
  ApplicationError,
  ConnectionState,
  ResourceEditorTab,
  RequestTab,
} from "@/model/domain/application";

export const useApplicationStore = defineStore("application", {
  state: () => ({
    session: null as CurrentSession | null,
    connection: "disconnected" as ConnectionState,
    workspaces: [] as WorkspaceSummary[],
    selectedWorkspaceId: null as string | null,
    selectedWorkspace: null as WorkspaceView | null,
    environments: [] as EnvironmentSummary[],
    selectedEnvironmentId: null as string | null,
    selectedEnvironment: null as EnvironmentView | null,
    selectedVariableProfile: null as VariableProfileView | null,
    variablePreviews: [] as VariablePreview[],
    rootNodes: [] as TreeNode[],
    selectedCollectionId: null as string | null,
    selectedCollection: null as CollectionView | null,
    collectionChildren: {} as Record<string, TreeNode[]>,
    expandedCollectionIds: [] as string[],
    requestTabs: [] as RequestTab[],
    activeRequestTabId: null as string | null,
    resourceTabs: [] as ResourceEditorTab[],
    workbenchTabOrder: [] as string[],
    activeWorkbenchTabId: null as string | null,
    busy: false,
    error: null as ApplicationError | null,
  }),
});
