import { defineStore } from "pinia";

import type {
  CollectionView,
  CurrentSession,
  TreeNode,
  WorkspaceSummary,
} from "@/model/contracts/backend";
import type {
  ApplicationError,
  ConnectionState,
  RequestTab,
} from "@/model/domain/application";

export const useApplicationStore = defineStore("application", {
  state: () => ({
    session: null as CurrentSession | null,
    connection: "disconnected" as ConnectionState,
    workspaces: [] as WorkspaceSummary[],
    selectedWorkspaceId: null as string | null,
    rootNodes: [] as TreeNode[],
    selectedCollectionId: null as string | null,
    selectedCollection: null as CollectionView | null,
    collectionChildren: {} as Record<string, TreeNode[]>,
    expandedCollectionIds: [] as string[],
    requestTabs: [] as RequestTab[],
    activeRequestTabId: null as string | null,
    busy: false,
    error: null as ApplicationError | null,
  }),
});
