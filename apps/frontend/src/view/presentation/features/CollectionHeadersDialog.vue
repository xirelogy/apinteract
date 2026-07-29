<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { CollectionView, RequestField } from "@/model/contracts/backend";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import CheckboxControl from "@/view/presentation/controls/CheckboxControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";

const props = defineProps<{
  collection: CollectionView;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [headers: readonly RequestField[]];
}>();
const { t } = useI18n();
const open = ref(true);
const headers = ref<RequestField[]>(props.collection.headers.map(cloneHeader));
const canSave = computed(() =>
  headers.value.every((header) => !header.enabled || header.name.trim() !== ""),
);

/** Copies one contract field into mutable dialog-local state. */
function cloneHeader(header: RequestField): RequestField {
  return { ...header };
}

/** Adds one enabled empty row ready for keyboard entry. */
function addHeader(): void {
  headers.value.push({ name: "", value: "", enabled: true });
}

/** Removes one common header by its visible ordered position. */
function removeHeader(index: number): void {
  headers.value.splice(index, 1);
}

/** Requests closure through the shared controlled dialog lifecycle. */
function close(): void {
  open.value = false;
}

/** Emits meaningful rows while preserving their declared order and state. */
function save(): void {
  if (!canSave.value) {
    return;
  }
  emit(
    "save",
    headers.value
      .filter((header) => header.name !== "" || header.value !== "")
      .map(cloneHeader),
  );
}
</script>

<template>
  <DialogControl
    v-model:open="open"
    class="resource-dialog collection-headers-dialog"
    aria-labelledby="collection-headers-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="collection-headers-title">
          {{ t("collection.headersTitle", { name: collection.name }) }}
        </h2>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <form class="resource-dialog-form" @submit.prevent="save">
        <p class="resource-dialog-context">
          {{ t("collection.headersDescription") }}
        </p>
        <div class="collection-header-fields">
          <div class="request-field-heading" aria-hidden="true">
            <span></span>
            <span>{{ t("common.fields.name") }}</span>
            <span>{{ t("common.fields.value") }}</span>
            <span></span>
          </div>
          <div
            v-for="(header, index) in headers"
            :key="index"
            class="request-field-row"
          >
            <CheckboxControl
              v-model="header.enabled"
              visually-hidden-label
              :label="
                t('request.enableField', {
                  kind: t('request.headerField'),
                  index: index + 1,
                })
              "
              :disabled="busy"
            />
            <TextInput
              v-model="header.name"
              class="field-cell-input"
              density="compact"
              font="mono"
              :aria-label="t('request.headerName', { index: index + 1 })"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <TextInput
              v-model="header.value"
              class="field-cell-input"
              density="compact"
              font="mono"
              :aria-label="t('request.headerValue', { index: index + 1 })"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy"
            />
            <IconButton
              size="compact"
              :label="
                t('request.removeField', {
                  kind: t('request.headerField'),
                  index: index + 1,
                })
              "
              :disabled="busy"
              @click="removeHeader(index)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </IconButton>
          </div>
          <ButtonControl
            class="add-field-button"
            variant="ghost"
            size="compact"
            :disabled="busy"
            @click="addHeader"
          >
            <template #leading>
              <Plus :size="15" aria-hidden="true" />
            </template>
            {{ t("collection.addHeader") }}
          </ButtonControl>
        </div>
        <footer class="resource-dialog-actions">
          <ButtonControl variant="secondary" :disabled="busy" @click="close">
            {{ t("common.actions.cancel") }}
          </ButtonControl>
          <ButtonControl
            variant="primary"
            type="submit"
            :disabled="busy || !canSave"
          >
            {{ t("common.actions.save") }}
          </ButtonControl>
        </footer>
      </form>
    </div>
  </DialogControl>
</template>
