<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useApplicationController } from "@/app/dependencies";
import type { WebBootstrapStatus } from "@/model/contracts/backend";
import { HttpProblemError } from "@/control/transport/http-client";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";

const properties = defineProps<{
  providers: WebBootstrapStatus["providers"];
}>();
const emit = defineEmits<{ completed: []; stale: [] }>();
const controller = useApplicationController();
const { t } = useI18n();
const selectedProviderId = ref(properties.providers[0]?.id ?? "");
const username = ref("admin");
const displayName = ref("Administrator");
const password = ref("");
const confirmation = ref("");
const submitting = ref(false);
const error = ref("");
const providerOptions = computed(() =>
  properties.providers.map((provider) => ({
    value: provider.id,
    label: provider.label,
  })),
);
const passwordsMatch = computed(
  () =>
    confirmation.value.length === 0 || password.value === confirmation.value,
);

/** Creates the first administrator without retaining password fields. */
async function submit(): Promise<void> {
  error.value = "";
  if (password.value !== confirmation.value) {
    error.value = t("auth.setup.passwordMismatch");
    return;
  }
  submitting.value = true;
  try {
    await controller.session.initializeFirstAdministrator({
      providerId: selectedProviderId.value,
      username: username.value,
      displayName: displayName.value,
      password: password.value,
    });
    password.value = "";
    confirmation.value = "";
    emit("completed");
  } catch (cause) {
    password.value = "";
    confirmation.value = "";
    if (
      cause instanceof HttpProblemError &&
      cause.problem.code === "web_bootstrap_already_completed"
    ) {
      emit("stale");
      return;
    }
    error.value =
      cause instanceof HttpProblemError && cause.problem.status === 429
        ? t("auth.setup.rateLimited")
        : t("auth.setup.failed");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="first-user-setup">
    <p class="setup-introduction">{{ t("auth.setup.introduction") }}</p>
    <form class="login-form" @submit.prevent="submit">
      <SelectMenu
        v-if="providers.length > 1"
        v-model="selectedProviderId"
        :label="t('auth.setup.method')"
        :options="providerOptions"
      />
      <div class="form-field">
        <label class="form-field-label" for="setup-username">
          {{ t("auth.username") }}
        </label>
        <input
          id="setup-username"
          v-model="username"
          class="text-input"
          type="text"
          autocomplete="username"
          maxlength="200"
          required
          autofocus
          aria-describedby="setup-username-hint"
        />
        <span id="setup-username-hint" class="form-field-hint">
          {{ t("auth.setup.usernameHint") }}
        </span>
      </div>
      <div class="form-field">
        <label class="form-field-label" for="setup-display-name">
          {{ t("auth.setup.displayName") }}
        </label>
        <input
          id="setup-display-name"
          v-model="displayName"
          class="text-input"
          type="text"
          autocomplete="name"
          maxlength="200"
          required
        />
      </div>
      <div class="form-field">
        <label class="form-field-label" for="setup-password">
          {{ t("auth.password") }}
        </label>
        <input
          id="setup-password"
          v-model="password"
          class="text-input"
          type="password"
          autocomplete="new-password"
          maxlength="1024"
          required
          aria-describedby="setup-password-hint"
        />
        <span id="setup-password-hint" class="form-field-hint">
          {{ t("auth.setup.passwordHint") }}
        </span>
      </div>
      <div class="form-field">
        <label class="form-field-label" for="setup-password-confirmation">
          {{ t("auth.setup.confirmPassword") }}
        </label>
        <input
          id="setup-password-confirmation"
          v-model="confirmation"
          class="text-input"
          :data-invalid="passwordsMatch ? undefined : ''"
          :aria-invalid="!passwordsMatch"
          type="password"
          autocomplete="new-password"
          maxlength="1024"
          required
          aria-describedby="setup-password-error"
        />
      </div>
      <p
        v-if="!passwordsMatch"
        id="setup-password-error"
        class="form-field-error"
        role="alert"
      >
        {{ t("auth.setup.passwordMismatch") }}
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button
        class="button-control primary-button login-submit"
        type="submit"
        :disabled="submitting || !passwordsMatch"
      >
        {{ submitting ? t("auth.setup.creating") : t("auth.setup.create") }}
      </button>
    </form>
  </div>
</template>
