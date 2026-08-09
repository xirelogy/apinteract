<script setup lang="ts">
import { TriangleAlert } from "@lucide/vue";

/** Renders a reusable, assertively announced warning for consequential UI state. */
defineProps<{
  title: string;
}>();

defineSlots<{
  default(): unknown;
}>();
</script>

<template>
  <aside class="inline-warning" role="alert">
    <TriangleAlert class="inline-warning-icon" :size="18" aria-hidden="true" />
    <div class="inline-warning-content">
      <strong>{{ title }}</strong>
      <p><slot /></p>
    </div>
  </aside>
</template>
