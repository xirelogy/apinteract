<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from "vue";
import {
  Check,
  Copy,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
  Trash2,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import {
  formatDateTime,
  useDateTimeFormatPreference,
} from "@/app/preferences/date-time-format";
import type { CookieJarView } from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import InfoPopover from "@/view/presentation/controls/InfoPopover.vue";
import ResourceDeleteDialog from "./ResourceDeleteDialog.vue";

const props = defineProps<{
  jar: CookieJarView;
  busy: boolean;
  canEdit: boolean;
}>();
const emit = defineEmits<{
  deleteCookie: [cookieId: string];
  clear: [scope: "session" | "all"];
}>();
const { locale, t } = useI18n();
const dateTimeFormatPreference = useDateTimeFormatPreference();
const copiedCookieId = ref<string | null>(null);
const clearConfirmationScope = ref<"session" | "all" | null>(null);
const clearDialogTitleId = `cookie-clear-dialog-title-${useId()}`;
let copiedResetTimer: ReturnType<typeof setTimeout> | undefined;
const hasSessionCookies = computed(() =>
  props.jar.cookies.some((cookie) => cookie.session),
);
const clearConfirmationCopy = computed(() =>
  clearConfirmationScope.value === "session"
    ? {
        title: t("cookies.clearSessionTitle"),
        message: t("cookies.clearSessionMessage"),
        confirmLabel: t("cookies.clearSession"),
      }
    : {
        title: t("cookies.clearAllTitle"),
        message: t("cookies.clearAllMessage"),
        confirmLabel: t("cookies.clearAll"),
      },
);

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) clearTimeout(copiedResetTimer);
});

/** Copies one cookie value without expanding it in the visible row. */
async function copyCookieValue(cookieId: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copiedCookieId.value = cookieId;
    if (copiedResetTimer !== undefined) clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      copiedCookieId.value = null;
      copiedResetTimer = undefined;
    }, 1_500);
  } catch {
    // Clipboard permission failures leave the row unchanged.
  }
}

/** Formats a persistent cookie expiry in local time using browser preferences. */
function formatExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return t("cookies.noExpiry");
  return formatDateTime(
    expiresAt,
    locale.value,
    dateTimeFormatPreference.dateTimeFormat.value,
  );
}

/** Opens confirmation for one supported cookie-jar clearing scope. */
function requestClear(scope: "session" | "all"): void {
  if (!props.busy && props.canEdit) clearConfirmationScope.value = scope;
}

/** Synchronizes dismissal of the controlled cookie-clear confirmation. */
function setClearConfirmationOpen(open: boolean): void {
  if (!open) clearConfirmationScope.value = null;
}

/** Confirms the selected clearing scope before requesting its mutation. */
function confirmClear(): void {
  const scope = clearConfirmationScope.value;
  if (scope === null || props.busy || !props.canEdit) return;
  clearConfirmationScope.value = null;
  emit("clear", scope);
}
</script>

<template>
  <section class="cookie-jar-panel" :aria-label="t('cookies.contentTitle')">
    <h3 class="resource-dialog-section-title">
      {{ t("cookies.contentTitle") }}
    </h3>
    <p v-if="jar.cookies.length === 0" class="cookie-jar-empty">
      {{ t("cookies.empty") }}
    </p>
    <div v-else class="cookie-list">
      <div class="cookie-list-heading" aria-hidden="true">
        <span>{{ t("common.fields.name") }}</span>
        <span>{{ t("common.fields.value") }}</span>
        <span>{{ t("cookies.scope") }}</span>
        <span>{{ t("cookies.expiry") }}</span>
        <span>{{ t("cookies.attributes") }}</span>
        <span></span>
      </div>
      <ul>
        <li
          v-for="storedCookie in jar.cookies"
          :key="storedCookie.cookieId"
          class="cookie-list-item"
        >
          <div class="cookie-list-cell">
            <span class="cookie-cell-label">{{ t("common.fields.name") }}</span>
            <strong>{{ storedCookie.name }}</strong>
          </div>
          <div class="cookie-list-cell cookie-value-cell">
            <span class="cookie-cell-label">{{
              t("common.fields.value")
            }}</span>
            <span class="cookie-value-control">
              <code class="cookie-value">{{ storedCookie.value }}</code>
              <IconButton
                size="compact"
                :label="
                  copiedCookieId === storedCookie.cookieId
                    ? t('cookies.valueCopied', { name: storedCookie.name })
                    : t('cookies.copyValue', { name: storedCookie.name })
                "
                @click="
                  copyCookieValue(storedCookie.cookieId, storedCookie.value)
                "
              >
                <Check
                  v-if="copiedCookieId === storedCookie.cookieId"
                  :size="15"
                  aria-hidden="true"
                />
                <Copy v-else :size="15" aria-hidden="true" />
              </IconButton>
            </span>
          </div>
          <div class="cookie-list-cell">
            <span class="cookie-cell-label">{{ t("cookies.scope") }}</span>
            <code>{{ storedCookie.domain }}{{ storedCookie.path }}</code>
          </div>
          <div class="cookie-list-cell">
            <span class="cookie-cell-label">{{ t("cookies.expiry") }}</span>
            <span>{{ formatExpiry(storedCookie.expiresAt) }}</span>
          </div>
          <div class="cookie-list-cell cookie-attributes">
            <span class="cookie-cell-label">{{ t("cookies.attributes") }}</span>
            <span class="cookie-attribute-icons">
              <InfoPopover
                v-if="storedCookie.secure"
                :label="t('cookies.secureTitle')"
              >
                <template #icon>
                  <LockKeyhole :size="15" aria-hidden="true" />
                </template>
                <span class="cookie-attribute-details">
                  <strong>{{ t("cookies.secureTitle") }}</strong>
                  <span>{{ t("cookies.secureDescription") }}</span>
                </span>
              </InfoPopover>
              <InfoPopover
                v-if="storedCookie.httpOnly"
                :label="t('cookies.httpOnlyTitle')"
              >
                <template #icon>
                  <EyeOff :size="15" aria-hidden="true" />
                </template>
                <span class="cookie-attribute-details">
                  <strong>{{ t("cookies.httpOnlyTitle") }}</strong>
                  <span>{{ t("cookies.httpOnlyDescription") }}</span>
                </span>
              </InfoPopover>
              <InfoPopover
                v-if="storedCookie.sameSite !== null"
                :label="
                  t('cookies.sameSiteTitle', {
                    value: storedCookie.sameSite,
                  })
                "
              >
                <template #icon>
                  <ShieldCheck :size="15" aria-hidden="true" />
                </template>
                <span class="cookie-attribute-details">
                  <strong>{{
                    t("cookies.sameSiteTitle", {
                      value: storedCookie.sameSite,
                    })
                  }}</strong>
                  <span>{{ t("cookies.sameSiteDescription") }}</span>
                </span>
              </InfoPopover>
            </span>
          </div>
          <div class="row-actions">
            <IconButton
              v-if="canEdit"
              size="compact"
              :label="t('cookies.deleteCookie', { name: storedCookie.name })"
              :disabled="busy"
              @click="emit('deleteCookie', storedCookie.cookieId)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </IconButton>
          </div>
        </li>
      </ul>
    </div>

    <footer class="cookie-jar-actions">
      <ButtonControl
        variant="secondary"
        :disabled="busy || !canEdit || !hasSessionCookies"
        @click="requestClear('session')"
      >
        {{ t("cookies.clearSession") }}
      </ButtonControl>
      <ButtonControl
        variant="danger-outline"
        :disabled="busy || !canEdit || jar.cookies.length === 0"
        @click="requestClear('all')"
      >
        {{ t("cookies.clearAll") }}
      </ButtonControl>
    </footer>

    <ResourceDeleteDialog
      class="cookie-clear-dialog"
      :open="clearConfirmationScope !== null"
      :title-id="clearDialogTitleId"
      :title="clearConfirmationCopy.title"
      :message="clearConfirmationCopy.message"
      :additional-message="t('cookies.clearWarning')"
      :confirm-label="clearConfirmationCopy.confirmLabel"
      :busy="busy"
      @update:open="setClearConfirmationOpen"
      @confirm="confirmClear"
    />
  </section>
</template>
