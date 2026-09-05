<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useApplicationController } from "@/app/dependencies";
import { authProviderFrontendHost } from "@/app/plugins/auth-provider-host";
import type { WebBootstrapStatus } from "@/model/contracts/backend";
import AuthProviderLoginHost from "@/view/presentation/controls/AuthProviderLoginHost.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import FirstUserSetup from "@/view/presentation/features/FirstUserSetup.vue";
import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";
import logoUrl from "@brand/logo.png";

const { t } = useI18n();
const controller = useApplicationController();
const providers = authProviderFrontendHost.entries();
const bootstrap = ref<WebBootstrapStatus | null>(null);
const bootstrapLoading = ref(true);
const bootstrapError = ref(false);
const bootstrapCompleted = ref(false);
const selectedId = ref(
  providers.find((provider) => provider.descriptor.availability === "available")
    ?.descriptor.id ??
    providers[0]?.descriptor.id ??
    "",
);
const selected = computed(() =>
  providers.find((provider) => provider.descriptor.id === selectedId.value),
);
const selectedIsAvailable = computed(
  () => selected.value?.descriptor.availability === "available",
);
const providerOptions = computed(() =>
  providers.map((provider) => ({
    value: provider.descriptor.id,
    label: provider.descriptor.label,
    disabled: provider.descriptor.availability === "unavailable",
  })),
);
const showProviderDescription = computed(
  () =>
    !bootstrapLoading.value &&
    !bootstrap.value?.available &&
    selected.value?.descriptor.description !== undefined,
);
const showProviderLogin = computed(
  () =>
    !bootstrapLoading.value &&
    !bootstrap.value?.available &&
    selectedIsAvailable.value &&
    selected.value !== undefined,
);
const showProviderUnavailable = computed(
  () =>
    !bootstrapLoading.value &&
    !bootstrap.value?.available &&
    selected.value !== undefined &&
    !selectedIsAvailable.value,
);

/** Refreshes authoritative setup state without inferring it from the catalog. */
async function loadBootstrapStatus(): Promise<void> {
  bootstrapLoading.value = true;
  bootstrapError.value = false;
  try {
    bootstrap.value = await controller.session.webBootstrapStatus();
  } catch {
    bootstrapError.value = true;
  } finally {
    bootstrapLoading.value = false;
  }
}

/** Confirms creation and reveals ordinary sign-in without creating a session. */
function completeBootstrap(): void {
  bootstrap.value = { available: false, providers: [] };
  bootstrapCompleted.value = true;
}

void loadBootstrapStatus();
</script>

<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-locale">
        <LocaleSelector />
      </div>
      <img class="login-logo" :src="logoUrl" alt="APInteract" />
      <h1 id="login-title">
        {{ bootstrap?.available ? t("auth.setup.title") : t("auth.signIn") }}
      </h1>
      <p v-if="bootstrapCompleted" class="setup-success" role="status">
        {{ t("auth.setup.completed") }}
      </p>
      <p v-if="bootstrapLoading" role="status">
        {{ t("auth.setup.checking") }}
      </p>
      <p v-else-if="bootstrapError" class="form-error" role="alert">
        {{ t("auth.setup.statusFailed") }}
      </p>
      <FirstUserSetup
        v-else-if="bootstrap?.available"
        :providers="bootstrap.providers"
        @completed="completeBootstrap"
        @stale="loadBootstrapStatus"
      />
      <p v-else-if="providers.length === 0" class="form-error" role="alert">
        No authentication method is available.
      </p>
      <SelectMenu
        v-else-if="providers.length > 1"
        v-model="selectedId"
        class="auth-provider-selector"
        label="Sign-in method"
        :options="providerOptions"
      />
      <p v-if="showProviderDescription" class="auth-provider-description">
        {{ selected?.descriptor.description }}
      </p>
      <AuthProviderLoginHost
        v-if="showProviderLogin"
        :instance-id="selected?.descriptor.id ?? ''"
      />
      <p v-else-if="showProviderUnavailable" class="form-error" role="status">
        This sign-in method is temporarily unavailable.
      </p>
    </section>
  </main>
</template>
