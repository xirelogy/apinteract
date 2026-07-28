<script setup lang="ts">
import { inject } from "vue";

import { tabsContextKey } from "./tabs-context";

/** Provides roving keyboard focus for the triggers in one tabs composite. */
defineProps<{
  label: string;
}>();

defineSlots<{
  default(): unknown;
}>();

const injectedContext = inject(tabsContextKey);
if (injectedContext === undefined) {
  throw new Error("TabsList must be rendered inside TabsRoot.");
}
const context = injectedContext;

/** Moves focus through enabled tabs and optionally activates the destination. */
function handleKeydown(event: KeyboardEvent): void {
  const list = event.currentTarget;
  if (!(list instanceof HTMLElement)) {
    return;
  }
  const triggers = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
  ];
  const currentIndex = triggers.findIndex(
    (trigger) => trigger === document.activeElement,
  );
  if (currentIndex === -1 || triggers.length === 0) {
    return;
  }

  const rtl = document.documentElement.dir === "rtl";
  const previousKey =
    context.orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const nextKey =
    context.orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  let nextIndex: number | null = null;
  if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = triggers.length - 1;
  } else if (event.key === previousKey) {
    const direction = rtl && context.orientation === "horizontal" ? 1 : -1;
    nextIndex = (currentIndex + direction + triggers.length) % triggers.length;
  } else if (event.key === nextKey) {
    const direction = rtl && context.orientation === "horizontal" ? -1 : 1;
    nextIndex = (currentIndex + direction + triggers.length) % triggers.length;
  }

  if (nextIndex === null) {
    return;
  }
  event.preventDefault();
  const nextTrigger = triggers[nextIndex];
  nextTrigger?.focus();
  if (context.activationMode === "automatic") {
    nextTrigger?.click();
  }
}
</script>

<template>
  <div
    class="tabs-list"
    role="tablist"
    :aria-label="label"
    :aria-orientation="context.orientation"
    @keydown="handleKeydown"
  >
    <slot />
  </div>
</template>
