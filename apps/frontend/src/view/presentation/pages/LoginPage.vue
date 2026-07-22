<script setup lang="ts">
import { ref } from "vue";
import { ArrowRight, LockKeyhole, User } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import LocaleSelector from "@/view/presentation/features/LocaleSelector.vue";
import logoUrl from "@brand/logo.png";

const controller = useApplicationController();
const router = useRouter();
const { t } = useI18n();
const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

/** Authenticates submitted credentials and enters the workspace view. */
async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await controller.session.login(username.value, password.value);
    await router.push("/main");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("auth.failed");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-locale">
        <LocaleSelector />
      </div>
      <img class="login-logo" :src="logoUrl" alt="APInteract" />
      <h1 id="login-title">{{ t("auth.signIn") }}</h1>
      <form class="login-form" @submit.prevent="submit">
        <label class="input-field">
          <span>{{ t("auth.username") }}</span>
          <span class="input-with-icon">
            <User :size="17" aria-hidden="true" />
            <input
              v-model="username"
              autocomplete="username"
              required
              :disabled="busy"
            />
          </span>
        </label>
        <label class="input-field">
          <span>{{ t("auth.password") }}</span>
          <span class="input-with-icon">
            <LockKeyhole :size="17" aria-hidden="true" />
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </span>
        </label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button
          class="primary-button login-submit"
          type="submit"
          :disabled="busy"
        >
          <span>{{
            busy ? t("auth.signingIn") : t("common.actions.continue")
          }}</span>
          <ArrowRight :size="17" aria-hidden="true" />
        </button>
      </form>
    </section>
  </main>
</template>
