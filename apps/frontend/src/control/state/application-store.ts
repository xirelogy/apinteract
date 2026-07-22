import { defineStore } from "pinia";

import type {
  CurrentSession,
  TreeNode,
  WorkspaceSummary,
} from "@/model/contracts/backend";
import type { ConnectionState, RequestTab } from "@/model/domain/application";

export const useApplicationStore = defineStore("application", {
  state: () => ({
    session: null as CurrentSession | null,
    connection: "disconnected" as ConnectionState,
    workspaces: [] as WorkspaceSummary[],
    selectedWorkspaceId: null as string | null,
    rootNodes: [] as TreeNode[],
    selectedCollectionId: null as string | null,
    collectionChildren: {} as Record<string, TreeNode[]>,
    expandedCollectionIds: [] as string[],
    requestTabs: [] as RequestTab[],
    activeRequestTabId: null as string | null,
    busy: false,
    error: null as string | null,
  }),
});
