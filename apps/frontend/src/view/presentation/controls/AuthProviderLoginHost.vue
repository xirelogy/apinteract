<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { AuthProviderFrontendHandle } from "@apinteract/plugin-api/frontend/authentication";

import { useApplicationController } from "@/app/dependencies";
import { authProviderFrontendHost } from "@/app/plugins/auth-provider-host";
import { loadFrontendPlugins } from "@/app/plugins/frontend-plugin-loader";
import { frontendPluginRuntime } from "@/app/plugins/frontend-plugin-host";

const properties = defineProps<{ instanceId: string }>();
const container = ref<HTMLElement | null>(null);
const controller = useApplicationController();
const router = useRouter();
const { locale } = useI18n();
let handle: AuthProviderFrontendHandle | null = null;

/** Disposes the selected provider and mounts its isolated login contribution. */
function mountProvider(): void {
  handle?.destroy();
  handle = null;
  if (container.value === null) return;
  handle = authProviderFrontendHost.mount(
    container.value,
    properties.instanceId,
    locale.value,
    controller.session,
    () => {
      void loadFrontendPlugins(frontendPluginRuntime).then(() =>
        router.push("/main"),
      );
    },
  );
}

onMounted(mountProvider);
watch(() => properties.instanceId, mountProvider);
watch(locale, mountProvider);
onBeforeUnmount(() => {
  handle?.destroy();
  void controller.session.cancelAuthentication();
});
</script>

<template>
  <div ref="container" class="auth-provider-login-host" />
</template>
