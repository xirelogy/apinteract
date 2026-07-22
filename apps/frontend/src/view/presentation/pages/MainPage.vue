<script setup lang="ts">
import { onMounted, ref } from "vue";
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
const navigatorOpen = ref(false);
const {
  session,
  connection,
  workspaces,
  selectedWorkspaceId,
  rootNodes,
  selectedCollectionId,
  collectionChildren,
  expandedCollectionIds,
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

/** Toggles the mobile workspace navigator drawer. */
function toggleNavigator(): void {
  navigatorOpen.value = !navigatorOpen.value;
}

/** Closes the mobile workspace navigator drawer. */
function closeNavigator(): void {
  navigatorOpen.value = false;
}

/** Creates a request and reveals its editor after closing the mobile drawer. */
async function createRequest(name: string, targetUrl: string): Promise<void> {
  await controller.createRequest(name, targetUrl);
  closeNavigator();
}

/** Selects a request and reveals its editor after closing the mobile drawer. */
async function selectRequest(requestId: string): Promise<void> {
  await controller.selectRequest(requestId);
  closeNavigator();
}
</script>

<template>
  <div class="application-shell">
    <AppHeader
      :display-name="session?.user.displayName ?? ''"
      :connected="connection === 'authenticated'"
      :navigator-open="navigatorOpen"
      @logout="logout"
      @toggle-navigator="toggleNavigator"
    />
    <div v-if="error" class="global-error" role="alert">{{ error }}</div>
    <div class="application-body">
      <WorkspaceNavigator
        id="workspace-navigator"
        :class="{ 'is-mobile-open': navigatorOpen }"
        :workspaces="workspaces"
        :selected-workspace-id="selectedWorkspaceId"
        :root-nodes="rootNodes"
        :selected-collection-id="selectedCollectionId"
        :collection-children="collectionChildren"
        :expanded-collection-ids="expandedCollectionIds"
        :selected-request-id="request?.requestId ?? null"
        :busy="busy"
        @create-workspace="controller.createWorkspace($event)"
        @select-workspace="controller.selectWorkspace($event)"
        @create-collection="
          (name, parentCollectionId) =>
            controller.createCollection(name, parentCollectionId)
        "
        @select-collection="controller.selectCollection($event)"
        @toggle-collection="controller.toggleCollection($event)"
        @create-request="createRequest"
        @select-request="selectRequest"
      />
      <button
        v-if="navigatorOpen"
        class="navigator-scrim"
        type="button"
        aria-label="Close workspace navigator"
        @click="closeNavigator"
      ></button>
      <RequestEditor
        :request="request"
        :execution="execution"
        :busy="busy"
        @save="controller.saveRequest($event)"
        @execute="controller.executeRequest($event)"
      />
    </div>
  </div>
</template>
