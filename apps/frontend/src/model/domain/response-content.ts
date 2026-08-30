import { parser as xmlParser } from "@lezer/xml";
import type {
  ResponseContentContribution,
  ResponseContentKind,
  ResponseContentPresentation,
  ResponseContentPresenterContext,
  StructuredResponseView,
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

export type {
  ResponseContentKind,
  StructuredResponseView,
} from "@apinteract/plugin-api/frontend";

export interface ResponseContentAnalysis {
  readonly kind: ResponseContentKind;
  readonly mediaType: string | null;
  readonly previewComplete: boolean;
  readonly previewTruncated: boolean;
  readonly structured?: StructuredResponseView;
}

export type ResponseContentPresenter = ResponseContentContribution;

export const RASTER_IMAGE_MEDIA_TYPES = [
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
] as const;
const rasterImageMediaTypes = new Set<string>(RASTER_IMAGE_MEDIA_TYPES);

/** Owns response presenters without allowing contributed executable markup. */
export class ResponseContentPresenterRegistry {
  readonly #mediaTypes = new MediaTypeRegistry<ResponseContentPresenter>();

  /** Registers one presenter through deterministic media-type patterns. */
  register(presenter: ResponseContentPresenter): void {
    this.#mediaTypes.register({
      id: presenter.id,
      patterns: presenter.mediaTypes,
      ...(presenter.priority === undefined
        ? {}
        : { priority: presenter.priority }),
      value: presenter,
    });
  }

  /** Produces the selected bounded projection for a declared media type. */
  present(
    mediaType: string | null,
    context: Omit<ResponseContentPresenterContext, "mediaType">,
  ): ResponseContentPresentation | undefined {
    const normalized = normalizeMediaType(mediaType);
    if (normalized === null) return undefined;
    return this.#mediaTypes.resolve(normalized)?.present({
      ...context,
      mediaType: normalized,
    });
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

/** Reports whether a declared media type is supported by the raster viewer. */
export function isRasterImageMediaType(mediaType: string | null): boolean {
  return mediaType !== null && rasterImageMediaTypes.has(mediaType);
}

/** Classifies one response and prepares any safe structured text projection. */
export function analyzeResponseContent(
  execution: ExecutionView,
  capturedResponse = false,
  presenters: ResponseContentPresenterRegistry,
): ResponseContentAnalysis {
  const mediaType = responseMediaType(execution.headers);
  const bodyBytes = execution.bodyBytes ?? 0;
  const previewComplete = isResponsePreviewComplete(execution);
  const previewTruncated =
    execution.bodyPreview !== undefined && !previewComplete;

  if (bodyBytes === 0 && execution.bodyComplete) {
    return {
      kind: "empty",
      mediaType,
      previewComplete,
      previewTruncated: false,
    };
  }
  if (
    capturedResponse &&
    execution.bodyPreview === undefined &&
    execution.bodyBlobId === undefined
  ) {
    return {
      kind: "unavailable",
      mediaType,
      previewComplete,
      previewTruncated,
    };
  }
  const presentation = presenters.present(mediaType, {
    execution,
    previewComplete,
    previewTruncated,
  });
  if (presentation !== undefined) {
    return {
      ...presentation,
      mediaType,
      previewComplete,
      previewTruncated,
    };
  }
  if (execution.bodyPreview !== undefined) {
    return {
      kind: "text",
      mediaType,
      previewComplete,
      previewTruncated,
    };
  }
  return {
    kind: "binary",
    mediaType,
    previewComplete,
    previewTruncated,
  };
}

/** Validates JSON and formats only structural whitespace, preserving source tokens. */
export function parseJsonResponse(source: string): StructuredResponseView {
  try {
    JSON.parse(source);
  } catch {
    return { language: "json", valid: false };
  }
  return {
    language: "json",
    valid: true,
    value: formatJsonWhitespace(source),
  };
}

/** Validates XML through CodeMirror's non-executing parser and retains its source. */
export function parseXmlResponse(source: string): StructuredResponseView {
  const tree = xmlParser.parse(source);
  let valid = source.trim() !== "";
  tree.iterate({
    /** Marks parser recovery nodes as invalid structured XML. */
    enter(node) {
      if (node.type.isError) valid = false;
    },
  });
  return valid
    ? { language: "xml", valid: true, value: source }
    : { language: "xml", valid: false };
}

/** Inserts conventional JSON whitespace without parsing values into JS numbers. */
function formatJsonWhitespace(source: string): string {
  let result = "";
  let indentation = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (/\s/u.test(character)) continue;
    if (character === "{" || character === "[") {
      result += character;
      const next = nextNonWhitespace(source, index + 1);
      if (next !== (character === "{" ? "}" : "]")) {
        indentation += 1;
        result += `\n${"  ".repeat(indentation)}`;
      }
      continue;
    }
    if (character === "}" || character === "]") {
      const previous = previousNonWhitespace(source, index - 1);
      if (previous !== (character === "}" ? "{" : "[")) {
        indentation = Math.max(0, indentation - 1);
        result += `\n${"  ".repeat(indentation)}`;
      }
      result += character;
      continue;
    }
    if (character === ",") {
      result += `,\n${"  ".repeat(indentation)}`;
      continue;
    }
    result += character === ":" ? ": " : character;
  }
  return result;
}

/** Returns the next non-whitespace UTF-16 code unit in a source string. */
function nextNonWhitespace(source: string, from: number): string | undefined {
  for (let index = from; index < source.length; index += 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}

/** Returns the previous non-whitespace UTF-16 code unit in a source string. */
function previousNonWhitespace(
  source: string,
  from: number,
): string | undefined {
  for (let index = from; index >= 0; index -= 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}
