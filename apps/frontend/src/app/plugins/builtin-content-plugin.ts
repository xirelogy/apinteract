import type { FrontendPlugin } from "@apinteract/plugin-api/frontend";

import {
  parseJsonResponse,
  parseXmlResponse,
  RASTER_IMAGE_MEDIA_TYPES,
} from "@/model/domain/response-content";

/** Installs the host-owned request editors and safe response presenters. */
export const builtinContentPlugin: FrontendPlugin = {
  manifest: {
    apiVersion: 1,
    id: "apinteract.content",
    name: "APInteract content support",
    version: "1.0.0",
    target: "frontend",
  },
  /** Registers host-owned content editors, formatters, and presenters. */
  register(context) {
    context.register("request.content", {
      id: "none",
      label: {
        default: "None",
        translationKey: "request.bodyTypes.none",
      },
      bodyKind: "none",
      defaultContentType: null,
      defaultForBodyKind: true,
    });
    context.register("request.content", {
      id: "text",
      label: {
        default: "Text",
        translationKey: "request.bodyTypes.text",
      },
      bodyKind: "text",
      defaultContentType: "text/plain",
      textLanguage: "plain",
      defaultForBodyKind: true,
    });
    context.register("request.content", {
      id: "json",
      label: {
        default: "JSON",
        translationKey: "request.bodyTypes.json",
      },
      bodyKind: "text",
      defaultContentType: "application/json",
      mediaTypes: ["application/json", "*+json"],
      textLanguage: "json",
      format: (source) => {
        const parsed = parseJsonResponse(source);
        return parsed.valid && parsed.value !== undefined
          ? { valid: true, value: parsed.value }
          : { valid: false, error: "The request body is not valid JSON." };
      },
    });
    context.register("request.content", {
      id: "urlencoded",
      label: {
        default: "URL-encoded",
        translationKey: "request.bodyTypes.urlencoded",
      },
      bodyKind: "urlencoded",
      defaultContentType: "application/x-www-form-urlencoded",
      defaultForBodyKind: true,
    });
    context.register("request.content", {
      id: "multipart",
      label: {
        default: "Multipart",
        translationKey: "request.bodyTypes.multipart",
      },
      bodyKind: "multipart",
      defaultContentType: "multipart/form-data",
      defaultForBodyKind: true,
    });
    context.register("request.content", {
      id: "file",
      label: {
        default: "File",
        translationKey: "request.bodyTypes.file",
      },
      bodyKind: "file",
      defaultContentType: null,
      defaultForBodyKind: true,
    });
    context.register("response.content", {
      id: "json",
      mediaTypes: ["application/json", "text/json", "*+json"],
      present: ({ execution, previewComplete }) => ({
        kind: "json",
        ...(previewComplete && execution.bodyPreview !== undefined
          ? { structured: parseJsonResponse(execution.bodyPreview) }
          : {}),
      }),
    });
    context.register("response.content", {
      id: "html",
      mediaTypes: ["text/html", "application/xhtml+xml"],
      present: ({ execution, mediaType, previewComplete }) => ({
        kind: "html",
        ...(mediaType === "application/xhtml+xml" &&
        previewComplete &&
        execution.bodyPreview !== undefined
          ? { structured: parseXmlResponse(execution.bodyPreview) }
          : {}),
      }),
    });
    context.register("response.content", {
      id: "xml",
      mediaTypes: ["application/xml", "text/xml", "*+xml"],
      present: ({ execution, previewComplete }) => ({
        kind: "xml",
        ...(previewComplete && execution.bodyPreview !== undefined
          ? { structured: parseXmlResponse(execution.bodyPreview) }
          : {}),
      }),
    });
    context.register("response.content", {
      id: "raster-image",
      mediaTypes: RASTER_IMAGE_MEDIA_TYPES,
      present: () => ({ kind: "image" }),
    });
    context.register("response.content", {
      id: "text",
      mediaTypes: [
        "text/*",
        "application/javascript",
        "application/x-javascript",
        "application/ecmascript",
        "application/typescript",
      ],
      present: () => ({ kind: "text" }),
    });
  },
};
