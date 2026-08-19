<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  type CSSProperties,
} from "vue";
import { Info } from "@lucide/vue";

import IconButton from "./IconButton.vue";

/**
 * Presents optional explanatory copy on demand without reserving permanent
 * layout space, while retaining an explicit accessible trigger relationship.
 */
defineProps<{
  label: string;
}>();

defineSlots<{
  default(): unknown;
}>();

const root = ref<HTMLElement | null>(null);
const popup = ref<HTMLElement | null>(null);
const teleportTarget = ref<HTMLElement | null>(null);
const open = ref(false);
const positioned = ref(false);
const popupStyle = ref<CSSProperties>({});
const popupId = `info-popover-${useId()}`;

onMounted(() => {
  teleportTarget.value = root.value?.closest("dialog") ?? document.body;
  document.addEventListener("pointerdown", closeFromOutside);
  document.addEventListener("focusin", closeFromOutside);
  window.addEventListener("resize", closeFromViewportChange);
  window.addEventListener("scroll", closeFromViewportChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeFromOutside);
  document.removeEventListener("focusin", closeFromOutside);
  window.removeEventListener("resize", closeFromViewportChange);
  window.removeEventListener("scroll", closeFromViewportChange, true);
});

/** Opens and positions the explanatory surface beside its trigger. */
async function openPopover(): Promise<void> {
  open.value = true;
  positioned.value = false;
  await nextTick();
  positionPopover();
  positioned.value = true;
}

/** Positions the teleported surface within the visible viewport. */
function positionPopover(): void {
  const trigger = root.value?.querySelector<HTMLButtonElement>("button");
  const surface = popup.value;
  if (trigger === undefined || trigger === null || surface === null) return;

  const viewportPadding = 8;
  const gap = 4;
  const triggerBox = trigger.getBoundingClientRect();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  const preferredLeft =
    getComputedStyle(trigger).direction === "rtl"
      ? triggerBox.right - width
      : triggerBox.left;
  const left = Math.min(
    Math.max(viewportPadding, preferredLeft),
    window.innerWidth - viewportPadding - width,
  );
  const spaceBelow = window.innerHeight - triggerBox.bottom - gap;
  const preferredTop =
    height > spaceBelow && triggerBox.top > height
      ? triggerBox.top - gap - height
      : triggerBox.bottom + gap;
  const top = Math.min(
    Math.max(viewportPadding, preferredTop),
    window.innerHeight - viewportPadding - height,
  );
  popupStyle.value = { top: `${top}px`, left: `${left}px` };
}

/** Closes the explanatory surface without changing the current focus owner. */
function closePopover(): void {
  open.value = false;
  positioned.value = false;
}

/** Toggles the explanatory surface from pointer or keyboard activation. */
function togglePopover(): void {
  if (open.value) closePopover();
  else void openPopover();
}

/** Dismisses the surface with Escape while focus remains on its trigger. */
function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    closePopover();
  }
}

/** Dismisses the surface when pointer or focus leaves its owned elements. */
function closeFromOutside(event: Event): void {
  if (
    event.target instanceof Node &&
    !root.value?.contains(event.target) &&
    !popup.value?.contains(event.target)
  ) {
    closePopover();
  }
}

/** Dismisses a stale surface when its viewport relationship changes. */
function closeFromViewportChange(): void {
  closePopover();
}
</script>

<template>
  <span
    ref="root"
    class="info-popover-control"
    :data-state="open ? 'open' : 'closed'"
  >
    <IconButton
      class="info-popover-trigger"
      size="compact"
      :label="label"
      :aria-expanded="open"
      :aria-controls="open ? popupId : undefined"
      :aria-describedby="open ? popupId : undefined"
      @click="togglePopover"
      @keydown="handleTriggerKeydown"
    >
      <Info :size="15" aria-hidden="true" />
    </IconButton>
    <Teleport v-if="teleportTarget" :to="teleportTarget">
      <div
        v-if="open"
        :id="popupId"
        ref="popup"
        class="info-popover-popup"
        :class="{ 'is-positioned': positioned }"
        role="note"
        :aria-label="label"
        :style="popupStyle"
      >
        <slot />
      </div>
    </Teleport>
  </span>
</template>
