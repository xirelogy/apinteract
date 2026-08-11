<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
  type CSSProperties,
} from "vue";
import { MoreHorizontal } from "@lucide/vue";

import IconButton from "./IconButton.vue";

export interface ActionMenuItem {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly variant?: "default" | "danger";
}

const props = withDefaults(
  defineProps<{
    label: string;
    items: readonly ActionMenuItem[];
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{
  select: [value: string];
}>();

defineSlots<{
  trigger?(props: {
    open: boolean;
    popupId: string;
    toggle: () => void;
    keydown: (event: KeyboardEvent) => void;
  }): unknown;
  item?(props: { item: ActionMenuItem }): unknown;
}>();

const root = ref<HTMLElement | null>(null);
const popup = ref<HTMLElement | null>(null);
const teleportTarget = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);
const popupStyle = ref<CSSProperties>({});
const popupId = `action-menu-${useId()}`;

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      closeMenu(false);
    }
  },
);

onMounted(() => {
  teleportTarget.value = root.value?.closest("dialog") ?? document.body;
  document.addEventListener("pointerdown", closeFromOutside);
  window.addEventListener("resize", closeFromViewportChange);
  window.addEventListener("scroll", closeFromViewportChange, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeFromOutside);
  window.removeEventListener("resize", closeFromViewportChange);
  window.removeEventListener("scroll", closeFromViewportChange, true);
});

/** Opens the action surface and moves focus to its first enabled item. */
async function openMenu(preferredIndex = 0): Promise<void> {
  if (props.disabled || props.items.length === 0) {
    return;
  }
  open.value = true;
  activeIndex.value = enabledIndex(preferredIndex, 1);
  await nextTick();
  positionMenu();
  await nextTick();
  focusItem(activeIndex.value);
}

/** Positions the teleported action surface beside its owning row trigger. */
function positionMenu(): void {
  const triggerElement = root.value?.querySelector<HTMLButtonElement>("button");
  const popupElement = popup.value;
  if (triggerElement == null || popupElement === null) {
    return;
  }
  const viewportPadding = 8;
  const gap = 4;
  const triggerBox = triggerElement.getBoundingClientRect();
  const width = popupElement.offsetWidth;
  const height = popupElement.offsetHeight;
  const left = Math.min(
    Math.max(viewportPadding, triggerBox.right - width),
    window.innerWidth - viewportPadding - width,
  );
  const spaceBelow = window.innerHeight - triggerBox.bottom - gap;
  const top =
    height > spaceBelow && triggerBox.top > height
      ? triggerBox.top - gap - height
      : Math.min(
          triggerBox.bottom + gap,
          window.innerHeight - viewportPadding - height,
        );
  popupStyle.value = { top: `${top}px`, left: `${left}px` };
}

/** Closes the action surface and optionally restores trigger focus. */
function closeMenu(restoreFocus: boolean): void {
  if (!open.value) {
    return;
  }
  open.value = false;
  if (restoreFocus) {
    void nextTick(() =>
      root.value?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
  }
}

/** Toggles the menu after pointer or Enter/Space activation. */
function toggleMenu(): void {
  if (open.value) {
    closeMenu(false);
  } else {
    void openMenu();
  }
}

/** Opens directly at the first or last action from arrow-key input. */
function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const index = event.key === "ArrowDown" ? 0 : props.items.length - 1;
  void openMenu(index);
}

/** Implements menu navigation, dismissal, and focus restoration. */
function handlePopupKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    focusItem(enabledIndex(activeIndex.value + direction, direction));
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const direction = event.key === "Home" ? 1 : -1;
    const start = event.key === "Home" ? 0 : props.items.length - 1;
    focusItem(enabledIndex(start, direction));
  }
}

/** Returns the next enabled action while wrapping at either boundary. */
function enabledIndex(start: number, direction: 1 | -1): number {
  for (let offset = 0; offset < props.items.length; offset += 1) {
    const index =
      (start + offset * direction + props.items.length) % props.items.length;
    if (props.items[index]?.disabled !== true) {
      return index;
    }
  }
  return -1;
}

/** Focuses one rendered menu item and records it for subsequent navigation. */
function focusItem(index: number): void {
  if (index < 0) {
    return;
  }
  activeIndex.value = index;
  popup.value
    ?.querySelector<HTMLElement>(`[data-action-index="${index}"]`)
    ?.focus();
}

/** Emits one enabled action before restoring focus to its trigger. */
function selectItem(item: ActionMenuItem): void {
  if (item.disabled === true) {
    return;
  }
  emit("select", item.value);
  closeMenu(true);
}

/** Dismisses the menu when pointer interaction leaves its owned surface. */
function closeFromOutside(event: PointerEvent): void {
  if (
    event.target instanceof Node &&
    !root.value?.contains(event.target) &&
    !popup.value?.contains(event.target)
  ) {
    closeMenu(false);
  }
}

/** Dismisses a stale positioned menu when its viewport relationship changes. */
function closeFromViewportChange(): void {
  closeMenu(false);
}
</script>

<template>
  <div ref="root" class="action-menu-control">
    <slot
      name="trigger"
      :open="open"
      :popup-id="popupId"
      :toggle="toggleMenu"
      :keydown="handleTriggerKeydown"
    >
      <IconButton
        size="compact"
        :label="label"
        :disabled="disabled"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-controls="open ? popupId : undefined"
        @click="toggleMenu"
        @keydown="handleTriggerKeydown"
      >
        <MoreHorizontal :size="16" aria-hidden="true" />
      </IconButton>
    </slot>
    <Teleport v-if="teleportTarget" :to="teleportTarget">
      <div
        v-if="open"
        :id="popupId"
        ref="popup"
        class="action-menu-popup"
        role="menu"
        :aria-label="label"
        :style="popupStyle"
        @keydown="handlePopupKeydown"
      >
        <button
          v-for="(item, index) in items"
          :key="item.value"
          class="action-menu-item"
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          :data-variant="item.variant ?? 'default'"
          :tabindex="index === activeIndex ? 0 : -1"
          :data-action-index="index"
          @click="selectItem(item)"
        >
          <slot name="item" :item="item">{{ item.label }}</slot>
        </button>
      </div>
    </Teleport>
  </div>
</template>
