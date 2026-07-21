<script setup lang="ts">
import { ref } from "vue";
import { ArrowRight, LockKeyhole, User } from "@lucide/vue";
import { useRouter } from "vue-router";

import logoUrl from "../../../../../logo.png";
import { useApplicationController } from "@/app/dependencies";

const controller = useApplicationController();
const router = useRouter();
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
    error.value =
      cause instanceof Error ? cause.message : "Authentication failed.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <img class="login-logo" :src="logoUrl" alt="APInteract" />
      <h1 id="login-title">Sign in</h1>
      <form class="login-form" @submit.prevent="submit">
        <label class="input-field">
          <span>Username</span>
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
          <span>Password</span>
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
          <span>{{ busy ? "Signing in" : "Continue" }}</span>
          <ArrowRight :size="17" aria-hidden="true" />
        </button>
      </form>
    </section>
  </main>
</template>
