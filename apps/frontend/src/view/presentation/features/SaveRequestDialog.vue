<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode } from "@/model/contracts/backend";
import type {
  CollectionChildrenState,
  RequestTab,
} from "@/model/domain/application";
import ButtonControl from "@/view/presentation/controls/ButtonControl.vue";
import FormField from "@/view/presentation/controls/FormField.vue";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import TextInput from "@/view/presentation/controls/TextInput.vue";
import DialogControl from "@/view/presentation/controls/dialog/DialogControl.vue";
import { useTreeNavigation } from "@/view/presentation/controls/tree/useTreeNavigation";
import CollectionPickerTreeNode from "./CollectionPickerTreeNode.vue";

const props = defineProps<{
  tab: RequestTab;
  rootNodes: readonly TreeNode[];
  collectionChildren: Readonly<Record<string, CollectionChildrenState>>;
  busy: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  close: [];
  expandCollection: [collectionId: string];
  save: [name: string, parentCollectionId: string];
}>();

const open = ref(true);
const name = ref(props.tab.draft.name);
const collectionRoots = computed(() =>
  props.rootNodes.filter((node) => node.kind === "collection"),
);
const parentCollectionId = ref(
  props.tab.pendingParentCollectionId ?? collectionRoots.value[0]?.nodeId ?? "",
);
const expandedCollectionIds = ref(
  collectionPath(
    props.rootNodes,
    props.collectionChildren,
    parentCollectionId.value,
  ),
);
const canSave = computed(
  () => name.value.trim() !== "" && parentCollectionId.value !== "",
);
const treeNavigation = useTreeNavigation();

/** Requests closure through the shared controlled dialog lifecycle. */
function close(): void {
  open.value = false;
}

/** Emits a normalized saved-request destination. */
function save(): void {
  if (!canSave.value) {
    return;
  }
  emit("save", name.value.trim(), parentCollectionId.value);
}

/** Expands or collapses one picker branch and requests unloaded children. */
function toggleCollection(collectionId: string): void {
  if (expandedCollectionIds.value.includes(collectionId)) {
    expandedCollectionIds.value = expandedCollectionIds.value.filter(
      (candidate) => candidate !== collectionId,
    );
    return;
  }
  expandedCollectionIds.value = [...expandedCollectionIds.value, collectionId];
  const state = props.collectionChildren[collectionId];
  if (state === undefined || state.status === "error") {
    emit("expandCollection", collectionId);
  }
}

/** Finds the loaded collection path leading to a selected destination. */
function collectionPath(
  nodes: readonly TreeNode[],
  children: Readonly<Record<string, CollectionChildrenState>>,
  collectionId: string,
): string[] {
  for (const node of nodes) {
    if (node.kind !== "collection") {
      continue;
    }
    if (node.nodeId === collectionId) {
      return [node.nodeId];
    }
    const childPath = collectionPath(
      children[node.nodeId]?.children ?? [],
      children,
      collectionId,
    );
    if (childPath.length > 0) {
      return [node.nodeId, ...childPath];
    }
  }
  return [];
}
</script>

<template>
  <DialogControl
    v-model:open="open"
    class="resource-dialog"
    aria-labelledby="save-request-title"
    @close="emit('close')"
  >
    <div class="resource-dialog-surface">
      <header class="resource-dialog-header">
        <h2 id="save-request-title">{{ t("request.saveDialog") }}</h2>
        <IconButton
          :label="t('common.actions.close')"
          :disabled="busy"
          @click="close"
        >
          <X :size="18" aria-hidden="true" />
        </IconButton>
      </header>
      <form class="resource-dialog-form" @submit.prevent="save">
        <FormField
          v-slot="{ controlId, describedBy, invalid }"
          :label="t('request.name')"
        >
          <TextInput
            :id="controlId"
            v-model="name"
            :aria-describedby="describedBy"
            :invalid="invalid"
            :aria-label="t('request.savedName')"
            autocomplete="off"
            autofocus
            :disabled="busy"
          />
        </FormField>
        <fieldset class="collection-picker-field">
          <legend>{{ t("collection.label") }}</legend>
          <div v-if="collectionRoots.length > 0" class="collection-picker">
            <ul
              class="workspace-tree-root"
              role="tree"
              :aria-label="t('collection.destination')"
              @focusin="treeNavigation.handleFocusIn"
              @keydown="treeNavigation.handleKeydown"
            >
              <CollectionPickerTreeNode
                v-for="node in collectionRoots"
                :key="node.nodeId"
                :node="node"
                :collection-children="collectionChildren"
                :expanded-collection-ids="expandedCollectionIds"
                :selected-collection-id="parentCollectionId"
                :busy="busy"
                :parent-node-id="null"
                :level="1"
                @select="parentCollectionId = $event"
                @toggle="toggleCollection"
                @retry="emit('expandCollection', $event)"
              />
            </ul>
          </div>
        </fieldset>
        <p v-if="collectionRoots.length === 0" class="dialog-empty-message">
          {{ t("collection.createBeforeSaving") }}
        </p>
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
