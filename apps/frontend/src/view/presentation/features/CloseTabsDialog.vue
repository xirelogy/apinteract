<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import AlertDialog from "@/view/presentation/controls/dialog/AlertDialog.vue";

const props = defineProps<{
  tabCount: number;
  dirtyTabNames: readonly string[];
  runningCount: number;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
}>();
const { t } = useI18n();
const open = ref(true);
const title = computed(() =>
  t(
    props.tabCount === 1
      ? "workbench.bulkClose.titleOne"
      : "workbench.bulkClose.titleMany",
  ),
);
const summary = computed(() =>
  t(
    props.tabCount === 1
      ? "workbench.bulkClose.summaryOne"
      : "workbench.bulkClose.summaryMany",
    { count: props.tabCount },
  ),
);
const dirtySummary = computed(() =>
  t(
    props.dirtyTabNames.length === 1
      ? "workbench.bulkClose.unsavedOne"
      : "workbench.bulkClose.unsavedMany",
    { count: props.dirtyTabNames.length },
  ),
);
const runningSummary = computed(() =>
  t(
    props.runningCount === 1
      ? "workbench.bulkClose.runningOne"
      : "workbench.bulkClose.runningMany",
    { count: props.runningCount },
  ),
);
const confirmLabel = computed(() =>
  t(
    props.tabCount === 1
      ? "workbench.bulkClose.confirmOne"
      : "workbench.bulkClose.confirmMany",
  ),
);

/** Closes the confirmation without changing any workbench tabs. */
function close(): void {
  open.value = false;
}
</script>

<template>
  <AlertDialog
    v-model:open="open"
    class="resource-dialog discard-dialog close-tabs-dialog"
    aria-labelledby="close-tabs-dialog-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="close-tabs-dialog-title">{{ title }}</h2>
        <IconButton :label="t('common.actions.close')" @click="close">
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <div class="discard-dialog-content close-tabs-dialog-content">
        <p>{{ summary }}</p>
        <template v-if="dirtyTabNames.length > 0">
          <p>{{ dirtySummary }}</p>
          <ul class="close-tabs-dirty-list">
            <li
              v-for="(name, index) in dirtyTabNames"
              :key="`${index}:${name}`"
            >
              {{ name }}
            </li>
          </ul>
        </template>
        <p v-if="runningCount > 0" class="close-tabs-running-warning">
          {{ runningSummary }}
        </p>
        <footer class="resource-dialog-actions">
          <ButtonControl variant="secondary" autofocus @click="close">
            {{ t("workbench.bulkClose.keepOpen") }}
          </ButtonControl>
          <ButtonControl variant="danger" @click="emit('confirm')">
            {{ confirmLabel }}
          </ButtonControl>
        </footer>
      </div>
    </div>
  </AlertDialog>
</template>
