<script setup lang="ts">
import { ref } from "vue";
import { ArrowRight, LockKeyhole, User } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

import { useApplicationController } from "@/app/dependencies";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
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
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="t('auth.username')"
        >
          <span class="input-with-icon">
            <User :size="17" aria-hidden="true" />
            <TextInput
              :id="controlId"
              v-model="username"
              :aria-describedby="describedBy"
              :invalid="invalid"
              autocomplete="username"
              required
              :disabled="busy"
            />
          </span>
        </FormField>
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="t('auth.password')"
        >
          <span class="input-with-icon">
            <LockKeyhole :size="17" aria-hidden="true" />
            <TextInput
              :id="controlId"
              v-model="password"
              type="password"
              :aria-describedby="describedBy"
              :invalid="invalid"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </span>
        </FormField>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <ButtonControl
          class="login-submit"
          variant="primary"
          type="submit"
          :busy="busy"
        >
          {{ busy ? t("auth.signingIn") : t("common.actions.continue") }}
          <template #trailing>
            <ArrowRight :size="17" aria-hidden="true" />
          </template>
        </ButtonControl>
      </form>
    </section>
  </main>
</template>
