import { parser as xmlParser } from "@lezer/xml";

import type { ExecutionView } from "@/model/contracts/backend";

export const RESPONSE_TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024;
export const RESPONSE_IMAGE_PREVIEW_LIMIT_BYTES = 16 * 1024 * 1024;
export const RESPONSE_IMAGE_MAX_DIMENSION = 16_384;
export const RESPONSE_IMAGE_MAX_PIXELS = 40_000_000;

export type ResponseContentKind =
  | "empty"
  | "text"
  | "json"
  | "xml"
  | "html"
  | "image"
  | "binary"
  | "unavailable";

export interface StructuredResponseView {
  readonly language: "json" | "xml";
  readonly value?: string;
  readonly valid: boolean;
}

export interface ResponseContentAnalysis {
  readonly kind: ResponseContentKind;
  readonly mediaType: string | null;
  readonly previewComplete: boolean;
  readonly previewTruncated: boolean;
  readonly structured?: StructuredResponseView;
}

const rasterImageMediaTypes = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

/** Returns the normalized first declared response media type, without parameters. */
export function responseMediaType(
  headers: ExecutionView["headers"],
): string | null {
  const value = headers?.find(
    (header) => header.name.trim().toLowerCase() === "content-type",
  )?.value;
  if (value === undefined) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : null;
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
  if (mediaType !== null && isJsonMediaType(mediaType)) {
    return {
      kind: "json",
      mediaType,
      previewComplete,
      previewTruncated,
      ...(previewComplete && execution.bodyPreview !== undefined
        ? { structured: parseJsonResponse(execution.bodyPreview) }
        : {}),
    };
  }
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return {
      kind: "html",
      mediaType,
      previewComplete,
      previewTruncated,
      ...(mediaType === "application/xhtml+xml" &&
      previewComplete &&
      execution.bodyPreview !== undefined
        ? { structured: parseXmlResponse(execution.bodyPreview) }
        : {}),
    };
  }
  if (mediaType !== null && isXmlMediaType(mediaType)) {
    return {
      kind: "xml",
      mediaType,
      previewComplete,
      previewTruncated,
      ...(previewComplete && execution.bodyPreview !== undefined
        ? { structured: parseXmlResponse(execution.bodyPreview) }
        : {}),
    };
  }
  if (isRasterImageMediaType(mediaType)) {
    return {
      kind: "image",
      mediaType,
      previewComplete,
      previewTruncated,
    };
  }
  if (
    execution.bodyPreview !== undefined ||
    mediaType?.startsWith("text/") === true ||
    mediaType?.includes("javascript") === true
  ) {
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

/** Reports whether a normalized media type follows JSON registration conventions. */
function isJsonMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    mediaType === "text/json" ||
    mediaType.endsWith("+json")
  );
}

/** Reports whether a normalized media type follows XML registration conventions. */
function isXmlMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    mediaType.endsWith("+xml")
  );
}

/** Validates JSON and formats only structural whitespace, preserving source tokens. */
function parseJsonResponse(source: string): StructuredResponseView {
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
function parseXmlResponse(source: string): StructuredResponseView {
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
