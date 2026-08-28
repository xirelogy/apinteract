<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";

import { activatePwaUpdate, updateAvailable } from "@/app/pwa-registration";
import { useApplicationStore } from "@/control/state/application-store";
import {
  isRequestTabDirty,
  isResourceEditorTabDirty,
} from "@/model/domain/application";

const store = useApplicationStore();
const logoUrl = `${import.meta.env.BASE_URL}logo.svg`;
const { connection, requestTabs, resourceTabs, session } = storeToRefs(store);
const { t } = useI18n();
const connectionUnavailable = computed(
  () =>
    connection.value === "offline" ||
    connection.value === "reconnecting" ||
    (session.value !== null && connection.value !== "authenticated"),
);
const updateBlockedByDrafts = computed(
  () =>
    requestTabs.value.some(isRequestTabDirty) ||
    resourceTabs.value.some(isResourceEditorTabDirty),
);
const updateBlockedByExecution = computed(() =>
  requestTabs.value.some(
    (tab) =>
      tab.execution?.state === "created" || tab.execution?.state === "running",
  ),
);
const updateBlocked = computed(
  () => updateBlockedByDrafts.value || updateBlockedByExecution.value,
);
const updateBlockReason = computed(() =>
  updateBlockedByExecution.value
    ? t("pwa.updateExecutionBlocked")
    : t("pwa.updateDraftBlocked"),
);

/** Activates a waiting shell only after rechecking destructive reload guards. */
async function updateApplication(): Promise<void> {
  if (updateBlocked.value) return;
  await activatePwaUpdate();
}
</script>

<template>
  <main v-if="connectionUnavailable" class="pwa-connection-state" role="main">
    <img :src="logoUrl" alt="" width="128" height="128" />
    <h1>{{ t("pwa.offlineTitle") }}</h1>
    <p class="pwa-connection-description">
      {{
        connection !== "offline"
          ? t("pwa.reconnectingDescription")
          : t("pwa.offlineDescription")
      }}
    </p>
    <p class="pwa-connection-privacy">{{ t("pwa.offlinePrivacy") }}</p>
  </main>
  <RouterView v-else />
  <aside
    v-if="updateAvailable"
    class="pwa-update-notice"
    role="status"
    aria-live="polite"
  >
    <div>
      <strong>{{ t("pwa.updateTitle") }}</strong>
      <p class="pwa-update-description">
        {{ updateBlocked ? updateBlockReason : t("pwa.updateDescription") }}
      </p>
    </div>
    <button
      type="button"
      class="button-control primary-button"
      :disabled="updateBlocked"
      @click="updateApplication"
    >
      {{ t("pwa.updateAction") }}
    </button>
  </aside>
</template>
