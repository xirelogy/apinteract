<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  FrontendPluginViewHandle,
  FrontendPluginViewMount,
} from "@apinteract/plugin-api/frontend";

const props = defineProps<{
  mount: FrontendPluginViewMount<never>;
  context: unknown;
}>();
const container = ref<HTMLElement | null>(null);
let handle: FrontendPluginViewHandle<never> | null = null;

/** Replaces the mounted implementation when the contribution itself changes. */
function mountCurrent(): void {
  if (container.value === null) return;
  handle?.destroy();
  handle = props.mount(container.value, props.context as never);
}

onMounted(mountCurrent);
watch(
  () => props.mount,
  () => mountCurrent(),
);
watch(
  () => props.context,
  (context) => handle?.update(context as never),
);
onBeforeUnmount(() => {
  handle?.destroy();
  handle = null;
});
</script>

<template>
  <div ref="container" class="plugin-view-host"></div>
</template>
