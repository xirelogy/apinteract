<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { authProviderFrontendHost } from "@/app/plugins/auth-provider-host";
import AuthProviderLoginHost from "@/view/presentation/controls/AuthProviderLoginHost.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";
import logoUrl from "@brand/logo.png";

const { t } = useI18n();
const providers = authProviderFrontendHost.entries();
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
</script>

<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-locale">
        <LocaleSelector />
      </div>
      <img class="login-logo" :src="logoUrl" alt="APInteract" />
      <h1 id="login-title">{{ t("auth.signIn") }}</h1>
      <p v-if="providers.length === 0" class="form-error" role="alert">
        No authentication method is available.
      </p>
      <SelectMenu
        v-else-if="providers.length > 1"
        v-model="selectedId"
        class="auth-provider-selector"
        label="Sign-in method"
        :options="providerOptions"
      />
      <p
        v-if="selected?.descriptor.description"
        class="auth-provider-description"
      >
        {{ selected.descriptor.description }}
      </p>
      <AuthProviderLoginHost
        v-if="selectedIsAvailable && selected !== undefined"
        :instance-id="selected.descriptor.id"
      />
      <p v-else-if="selected !== undefined" class="form-error" role="status">
        This sign-in method is temporarily unavailable.
      </p>
    </section>
  </main>
</template>
