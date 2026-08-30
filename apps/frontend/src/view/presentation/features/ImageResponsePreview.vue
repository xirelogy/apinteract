<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ImageDimensions } from "@apinteract/plugin-api/frontend";

import {
  RESPONSE_IMAGE_MAX_DIMENSION,
  RESPONSE_IMAGE_MAX_PIXELS,
  RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES,
} from "@/model/domain/response-content";
const props = defineProps<{
  executionId: string;
  mediaType: string;
  byteLength: number;
  loadBody: (executionId: string) => Promise<Blob>;
  inspect: (mediaType: string, bytes: Uint8Array) => ImageDimensions | null;
}>();

const { t } = useI18n();
const state = ref<"loading" | "ready" | "invalid" | "too-large" | "failed">(
  "loading",
);
const dimensions = ref<ImageDimensions | null>(null);
const objectUrl = ref<string | null>(null);
let active = true;

/** Formats intrinsic image dimensions for visible metadata. */
const dimensionLabel = computed(() =>
  dimensions.value === null
    ? ""
    : t("response.imageDimensions", dimensions.value),
);

/** Loads bounded authorized bytes and validates dimensions before browser decode. */
async function load(): Promise<void> {
  if (props.byteLength > RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES) {
    state.value = "too-large";
    return;
  }
  state.value = "loading";
  try {
    const body = await props.loadBody(props.executionId);
    if (!active) return;
    if (
      body.size !== props.byteLength ||
      body.size > RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES
    ) {
      state.value = "invalid";
      return;
    }
    const header = await readBlobHeader(body);
    if (!active) return;
    const parsedDimensions = props.inspect(props.mediaType, header);
    if (parsedDimensions === null) {
      state.value = "invalid";
      return;
    }
    if (!withinDimensionLimits(parsedDimensions)) {
      dimensions.value = parsedDimensions;
      state.value = "too-large";
      return;
    }
    dimensions.value = parsedDimensions;
    objectUrl.value = URL.createObjectURL(
      body.slice(0, body.size, props.mediaType),
    );
  } catch {
    if (active) state.value = "failed";
  }
}

/** Reads only bounded image header bytes through the browser Blob API. */
function readBlobHeader(body: Blob): Promise<Uint8Array> {
  const part = body.slice(0, Math.min(body.size, 1024 * 1024));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
      } else {
        reject(new Error("Image header could not be read"));
      }
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Image header could not be read")),
    );
    reader.readAsArrayBuffer(part);
  });
}

/** Accepts a browser-decoded image only when it matches guarded metadata. */
function acceptDecodedImage(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  const parsedDimensions = dimensions.value;
  if (
    parsedDimensions === null ||
    image.naturalWidth !== parsedDimensions.width ||
    image.naturalHeight !== parsedDimensions.height ||
    !withinDimensionLimits({
      width: image.naturalWidth,
      height: image.naturalHeight,
    })
  ) {
    releaseObjectUrl();
    state.value = "invalid";
    return;
  }
  state.value = "ready";
}

/** Converts a browser decoder failure into a stable non-previewable state. */
function rejectDecodedImage(): void {
  releaseObjectUrl();
  state.value = "invalid";
}

/** Applies both per-axis and decoded-pixel resource limits. */
function withinDimensionLimits(value: ImageDimensions): boolean {
  return (
    value.width <= RESPONSE_IMAGE_MAX_DIMENSION &&
    value.height <= RESPONSE_IMAGE_MAX_DIMENSION &&
    value.width * value.height <= RESPONSE_IMAGE_MAX_PIXELS
  );
}

/** Revokes the current object URL exactly once. */
function releaseObjectUrl(): void {
  if (objectUrl.value === null) return;
  URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = null;
}

onMounted(() => void load());
onBeforeUnmount(() => {
  active = false;
  releaseObjectUrl();
});
</script>

<template>
  <div class="image-response-preview" :data-state="state">
    <p v-if="state === 'loading'" role="status">
      {{ t("response.imageLoading") }}
    </p>
    <img
      v-if="objectUrl !== null"
      :src="objectUrl"
      :alt="t('response.imageAlt')"
      @load="acceptDecodedImage"
      @error="rejectDecodedImage"
    />
    <p v-if="state === 'invalid'" role="alert">
      {{ t("response.imageInvalid") }}
    </p>
    <p v-else-if="state === 'too-large'" role="status">
      {{ t("response.imageTooLarge") }}
    </p>
    <p v-else-if="state === 'failed'" role="alert">
      {{ t("response.imageLoadFailed") }}
    </p>
    <dl v-if="state === 'ready'" class="image-response-metadata">
      <div>
        <dt>{{ t("response.mediaType") }}</dt>
        <dd>{{ mediaType }}</dd>
      </div>
      <div>
        <dt>{{ t("response.dimensions") }}</dt>
        <dd>{{ dimensionLabel }}</dd>
      </div>
    </dl>
  </div>
</template>
