<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { FilePlus, FolderPlus, Plus } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import type { TreeNode, WorkspaceSummary } from "@/model/contracts/backend";
import IconButton from "@/view/presentation/controls/IconButton.vue";
import SelectMenu from "@/view/presentation/controls/SelectMenu.vue";
import { useTreeNavigation } from "@/view/presentation/controls/tree/useTreeNavigation";
import CreateResourceDialog from "./CreateResourceDialog.vue";
import WorkspaceTreeNode from "./WorkspaceTreeNode.vue";

type CreationKind = "workspace" | "collection";

const props = defineProps<{
  workspaces: readonly WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  rootNodes: readonly TreeNode[];
  selectedCollectionId: string | null;
  collectionChildren: Readonly<Record<string, readonly TreeNode[]>>;
  expandedCollectionIds: readonly string[];
  selectedRequestId: string | null;
  busy: boolean;
  mobileOpen: boolean;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  createWorkspace: [name: string];
  selectWorkspace: [workspaceId: string];
  createCollection: [name: string, parentCollectionId: string | null];
  selectCollection: [collectionId: string];
  toggleCollection: [collectionId: string];
  createRequest: [parentCollectionId: string | null];
  selectRequest: [requestId: string];
  dismiss: [];
}>();

const navigator = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
const creationKind = ref<CreationKind | null>(null);
const creationParentCollectionId = ref<string | null>(null);
const workspaceOptions = computed(() =>
  props.workspaces.map((workspace) => ({
    value: workspace.workspaceId,
    label: workspace.name,
  })),
);
const creationParentName = computed(() =>
  creationParentCollectionId.value === null
    ? null
    : findLoadedNodeName(creationParentCollectionId.value),
);
const creationContext = computed(() =>
  creationParentName.value === null
    ? null
    : t("collection.inside", { name: creationParentName.value }),
);
const focusableNodeId = computed(
  () =>
    props.selectedRequestId ??
    props.selectedCollectionId ??
    props.rootNodes[0]?.nodeId ??
    null,
);
const treeNavigation = useTreeNavigation();

watch(
  () => props.mobileOpen,
  async (open) => {
    if (open) {
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      await nextTick();
      const initialFocus = focusableElements()[0] ?? navigator.value;
      initialFocus?.focus();
    } else {
      returnFocus?.focus();
      returnFocus = null;
    }
  },
);

onBeforeUnmount(() => returnFocus?.focus());

/** Returns enabled focus targets owned by the modal mobile navigator. */
function focusableElements(): HTMLElement[] {
  return [
    ...(navigator.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []),
  ];
}

/** Contains keyboard focus and handles expected mobile modal dismissal. */
function handleNavigatorKeydown(event: KeyboardEvent): void {
  if (!props.mobileOpen) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    emit("dismiss");
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableElements();
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    navigator.value?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Opens the creation dialog for one navigator resource type. */
function openCreationDialog(
  kind: CreationKind,
  parentCollectionId: string | null = null,
): void {
  creationKind.value = kind;
  creationParentCollectionId.value = parentCollectionId;
}

/** Clears the active creation mode after the modal closes. */
function closeCreationDialog(): void {
  creationKind.value = null;
  creationParentCollectionId.value = null;
}

/** Routes normalized modal fields to the existing creation events. */
function submitCreation(name: string): void {
  if (creationKind.value === "workspace") {
    emit("createWorkspace", name);
  } else if (creationKind.value === "collection") {
    emit("createCollection", name, creationParentCollectionId.value);
  }
}

/** Finds a loaded collection name for creation-dialog context. */
function findLoadedNodeName(nodeId: string): string | null {
  const groups = [props.rootNodes, ...Object.values(props.collectionChildren)];
  for (const group of groups) {
    const match = group.find((node) => node.nodeId === nodeId);
    if (match !== undefined) {
      return match.name;
    }
  }
  return null;
}
</script>

<template>
  <aside
    ref="navigator"
    class="workspace-navigator"
    :class="{ 'is-mobile-open': mobileOpen }"
    :role="mobileOpen ? 'dialog' : undefined"
    :aria-modal="mobileOpen ? 'true' : undefined"
    :aria-label="t('workspace.navigation')"
    :tabindex="mobileOpen ? -1 : undefined"
    @keydown="handleNavigatorKeydown"
  >
    <div class="navigator-section">
      <label class="navigator-heading" for="workspace-select">
        {{ t("workspace.label") }}
      </label>
      <div class="workspace-select-row">
        <SelectMenu
          input-id="workspace-select"
          class="workspace-picker"
          :model-value="selectedWorkspaceId ?? ''"
          :options="workspaceOptions"
          :label="t('workspace.label')"
          :placeholder="t('workspace.select')"
          :disabled="busy"
          @update:model-value="emit('selectWorkspace', $event)"
        />
        <IconButton
          :label="t('workspace.create')"
          :disabled="busy"
          @click="openCreationDialog('workspace')"
        >
          <Plus :size="17" aria-hidden="true" />
        </IconButton>
      </div>
    </div>

    <div v-if="selectedWorkspaceId" class="navigator-section navigator-grow">
      <div class="section-heading">
        <span class="navigator-heading">{{ t("workspace.collections") }}</span>
        <div class="section-actions">
          <IconButton
            class="compact-icon-button"
            size="compact"
            :label="t('workspace.createRootCollection')"
            :disabled="busy"
            @click="openCreationDialog('collection')"
          >
            <FolderPlus :size="16" aria-hidden="true" />
          </IconButton>
          <IconButton
            class="compact-icon-button"
            size="compact"
            :label="t('workspace.createRequest')"
            :disabled="busy || selectedCollectionId === null"
            @click="emit('createRequest', selectedCollectionId)"
          >
            <FilePlus :size="16" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <nav class="workspace-tree" :aria-label="t('workspace.tree')">
        <ul
          v-if="rootNodes.length > 0"
          class="workspace-tree-root"
          role="tree"
          :aria-label="t('workspace.tree')"
          @focusin="treeNavigation.handleFocusIn"
          @keydown="treeNavigation.handleKeydown"
        >
          <WorkspaceTreeNode
            v-for="node in rootNodes"
            :key="node.nodeId"
            :node="node"
            :collection-children="collectionChildren"
            :expanded-collection-ids="expandedCollectionIds"
            :selected-collection-id="selectedCollectionId"
            :selected-request-id="selectedRequestId"
            :busy="busy"
            :focusable-node-id="focusableNodeId"
            :parent-node-id="null"
            :level="1"
            @create-collection="openCreationDialog('collection', $event)"
            @select-collection="emit('selectCollection', $event)"
            @toggle-collection="emit('toggleCollection', $event)"
            @select-request="emit('selectRequest', $event)"
          />
        </ul>
        <p v-else class="tree-empty">{{ t("workspace.noCollections") }}</p>
      </nav>
    </div>

    <CreateResourceDialog
      v-if="creationKind !== null"
      :kind="creationKind"
      :busy="busy"
      :context="creationContext"
      @close="closeCreationDialog"
      @submit="submitCreation"
    />
  </aside>
</template>
