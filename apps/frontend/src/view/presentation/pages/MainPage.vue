<script setup lang="ts">
import { onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import { useApplicationStore } from "@/control/state/application-store";
import AppHeader from "@/view/presentation/layout/AppHeader.vue";
import RequestEditor from "@/view/presentation/features/RequestEditor.vue";
import WorkspaceNavigator from "@/view/presentation/features/WorkspaceNavigator.vue";

const controller = useApplicationController();
const store = useApplicationStore();
const router = useRouter();
const {
  session,
  connection,
  workspaces,
  selectedWorkspaceId,
  rootNodes,
  selectedCollectionId,
  collectionNodes,
  request,
  execution,
  busy,
  error,
} = storeToRefs(store);

onMounted(async () => {
  await controller.initializeWorkspace().catch(() => undefined);
});

/** Ends the current session and returns to the login view. */
async function logout(): Promise<void> {
  await controller.session.logout();
  await router.push("/login");
}
</script>

<template>
  <div class="application-shell">
    <AppHeader
      :display-name="session?.user.displayName ?? ''"
      :connected="connection === 'authenticated'"
      @logout="logout"
    />
    <div v-if="error" class="global-error" role="alert">{{ error }}</div>
    <div class="application-body">
      <WorkspaceNavigator
        :workspaces="workspaces"
        :selected-workspace-id="selectedWorkspaceId"
        :root-nodes="rootNodes"
        :selected-collection-id="selectedCollectionId"
        :collection-nodes="collectionNodes"
        :busy="busy"
        @create-workspace="controller.createWorkspace"
        @select-workspace="controller.selectWorkspace"
        @create-collection="controller.createCollection"
        @select-collection="controller.selectCollection"
        @create-request="controller.createRequest"
        @select-request="controller.selectRequest"
      />
      <RequestEditor
        :request="request"
        :execution="execution"
        :busy="busy"
        @save="controller.saveRequest"
        @execute="controller.executeRequest"
      />
    </div>
  </div>
</template>
