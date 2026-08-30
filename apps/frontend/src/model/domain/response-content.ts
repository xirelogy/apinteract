import type {
  ResponseContentContribution,
  ResponseContentPresenterContext,
} from "@apinteract/plugin-api/frontend";

import type { ExecutionView } from "@/model/contracts/backend";
import {
  MediaTypeRegistry,
  normalizeMediaType,
} from "@/model/domain/media-types";

export const RESPONSE_TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024;
export const RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES = 16 * 1024 * 1024;
export const RESPONSE_IMAGE_MAX_DIMENSION = 16_384;
export const RESPONSE_IMAGE_MAX_PIXELS = 40_000_000;

export type ResponseBodyState = "empty" | "text" | "binary" | "unavailable";

/** Describes transport-owned body state and an optional plugin-owned viewer. */
export interface ResponseContentAnalysis {
  readonly state: ResponseBodyState;
  readonly mediaType: string | null;
  readonly previewComplete: boolean;
  readonly previewTruncated: boolean;
  readonly viewer?: ResponseContentContribution;
  readonly viewerIsDefault: boolean;
}

/** Owns response viewer matching without knowing any content implementation. */
export class ResponseContentPresenterRegistry {
  readonly #mediaTypes = new MediaTypeRegistry<ResponseContentContribution>();

  /** Registers one executable viewer through deterministic media-type patterns. */
  register(viewer: ResponseContentContribution, ownerId = "host"): void {
    const id = `${ownerId}/${viewer.id}`;
    if (viewer.label.default.trim() === "") {
      throw new Error(`Response viewer label is required: ${id}`);
    }
    this.#mediaTypes.register({
      id,
      patterns: viewer.mediaTypes,
      ...(viewer.priority === undefined ? {} : { priority: viewer.priority }),
      value: Object.freeze({ ...viewer, id }),
    });
  }

  /** Returns registered viewers in stable installation order. */
  list(): readonly ResponseContentContribution[] {
    return this.#mediaTypes.values();
  }

  /** Selects one executable viewer for a normalized declared media type. */
  resolve(mediaType: string | null): ResponseContentContribution | undefined {
    return this.#mediaTypes.resolve(mediaType);
  }
}

/** Returns the normalized first declared response media type, without parameters. */
export function responseMediaType(
  headers: ExecutionView["headers"],
): string | null {
  const value = headers?.find(
    (header) => header.name.trim().toLowerCase() === "content-type",
  )?.value;
  if (value === undefined) return null;
  return normalizeMediaType(value);
}

/** Reports whether the bounded UTF-8 preview represents the complete body. */
export function isResponsePreviewComplete(execution: ExecutionView): boolean {
  if (
    !execution.bodyComplete ||
    execution.bodyPreview === undefined ||
    execution.bodyBytes === undefined
  ) {
    return false;
  }
  return (
    new TextEncoder().encode(execution.bodyPreview).byteLength ===
    execution.bodyBytes
  );
}

/** Classifies transport state and selects a plugin without interpreting content. */
export function analyzeResponseContent(
  execution: ExecutionView,
  capturedResponse = false,
  viewers: ResponseContentPresenterRegistry,
  loadBody?: (executionId: string) => Promise<Blob>,
  locale = "en-US",
): ResponseContentAnalysis {
  const mediaType = responseMediaType(execution.headers);
  const bodyBytes = execution.bodyBytes ?? 0;
  const previewComplete = isResponsePreviewComplete(execution);
  const previewTruncated =
    execution.bodyPreview !== undefined && !previewComplete;
  const viewer = viewers.resolve(mediaType);
  const viewerContext: Omit<ResponseContentPresenterContext, "ui"> = {
    execution,
    mediaType: mediaType ?? "application/octet-stream",
    locale,
    previewComplete,
    previewTruncated,
    ...(loadBody === undefined ? {} : { loadBody }),
  };
  const availableViewer =
    viewer !== undefined && (viewer.isAvailable?.(viewerContext) ?? true)
      ? viewer
      : undefined;

  let state: ResponseBodyState;
  if (bodyBytes === 0 && execution.bodyComplete) state = "empty";
  else if (
    capturedResponse &&
    execution.bodyPreview === undefined &&
    execution.bodyBlobId === undefined
  ) {
    state = "unavailable";
  } else if (execution.bodyPreview !== undefined) state = "text";
  else state = "binary";

  return {
    state,
    mediaType,
    previewComplete,
    previewTruncated,
    ...(availableViewer === undefined ? {} : { viewer: availableViewer }),
    viewerIsDefault: availableViewer?.isDefault?.(viewerContext) ?? false,
  };
}
