import type { components } from "@apinteract/api-contracts/backend";

import type { APInteractPluginModule } from "./core.js";

export type ImportProviderId = string;
export type ImportedHttpMethod = components["schemas"]["HttpMethod"];
export type ImportedVariableWrite = components["schemas"]["VariableWrite"];

/** Declares one source adapter and the normalized features it may produce. */
export interface ImportProviderManifest {
  readonly id: ImportProviderId;
  readonly version: string;
  readonly label: string;
  readonly acceptedExtensions: readonly string[];
  readonly acceptedMediaTypes: readonly string[];
  readonly inputKinds: readonly ["file"];
  readonly capabilities: {
    readonly multipleRequests: boolean;
    readonly hierarchy: boolean;
    readonly attachments: boolean;
    readonly capturedResponses: boolean;
    readonly responseExamples: boolean;
    readonly variables: boolean;
  };
}

/** Contains one bounded source presented to import providers without I/O access. */
export interface ImportSource {
  readonly name: string;
  readonly text: string;
}

/** Reports how confidently a provider recognizes a bounded source. */
export interface ImportProbeResult {
  readonly confidence: number;
  readonly reason: string;
}

export type ImportDiagnosticSeverity = "info" | "warning" | "error";

/** Represents one editable name/value field emitted by an import provider. */
export interface ImportedRequestField {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly mode?: "override" | "append";
  readonly description?: string;
}

/** Describes one immutable uploaded file referenced by an imported body. */
export interface ImportedRequestAttachment {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Preserves the wire-level request body variants accepted by the backend. */
export type ImportedRequestBodyDefinition =
  | { readonly kind: "none" }
  | {
      readonly kind: "text";
      readonly contentType: string | null;
      readonly text: string;
    }
  | {
      readonly kind: "file";
      readonly contentType: string | null;
      readonly attachment: ImportedRequestAttachment;
    }
  | {
      readonly kind: "urlencoded";
      readonly contentType: string | null;
      readonly fields: readonly ImportedRequestField[];
    }
  | {
      readonly kind: "multipart";
      readonly contentType: string | null;
      readonly boundary: string;
      readonly fields: readonly (
        | ImportedRequestField
        | {
            readonly kind: "file";
            readonly name: string;
            readonly enabled: boolean;
            readonly description?: string;
            readonly attachment: ImportedRequestAttachment;
          }
      )[];
    };

/** Describes one provider-defined request-body alternative selectable at import time. */
export interface ImportedRequestBodyOption {
  readonly optionId: string;
  readonly label: string;
  /** Stable provider-defined value used when one choice can apply to many requests. */
  readonly selectionKey?: string;
  readonly requestBody: ImportedRequestBodyDefinition;
  /** Provider-owned Markdown appended to request notes only when this option is selected. */
  readonly documentation?: string;
}

/** Describes a lossy, unsupported, or invalid source construct. */
export interface ImportDiagnostic {
  readonly code: string;
  readonly severity: ImportDiagnosticSeverity;
  readonly message: string;
  readonly itemId?: string;
  readonly itemIds?: readonly string[];
  readonly sourceLocation?: string;
  readonly sourceLocations?: readonly string[];
}

/** Describes one provider-created collection below the imported root. */
export interface ImportedCollection {
  readonly collectionKey: string;
  readonly parentCollectionKey: string | null;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly pathPrefix: string;
  readonly variables: readonly components["schemas"]["VariableWrite"][];
}

/** Preserves one recorded HTTP response without provider-controlled provenance. */
export interface ImportedCapturedExchange {
  readonly capturedExchangeId?: string;
  readonly label?: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly contentType: string | null;
  readonly body: string;
  readonly bodyEncoding: "text" | "base64";
  readonly bodyComplete: boolean;
  readonly bodyBytes: number;
  readonly recordedAt: string | null;
  readonly importedAt?: string;
}

/** Represents one source request normalized into APInteract draft semantics. */
export interface ImportedRequest {
  readonly itemId: string;
  readonly sourceLocation: string;
  readonly collectionKey: string | null;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly method: ImportedHttpMethod;
  readonly targetMode: "absolute" | "composed";
  readonly targetUrl: string;
  readonly query: readonly ImportedRequestField[];
  readonly headers: readonly ImportedRequestField[];
  readonly requestBody: ImportedRequestBodyDefinition;
  readonly requestBodyOptions?: readonly ImportedRequestBodyOption[];
  readonly defaultRequestBodyOptionId?: string;
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
  readonly variables: readonly components["schemas"]["VariableWrite"][];
  readonly capturedExchange?: ImportedCapturedExchange;
  readonly capturedExchanges?: readonly ImportedCapturedExchange[];
}

/** Describes a mutation-free canonical request and collection import preview. */
export interface ImportPlan {
  readonly schemaVersion: 1;
  readonly providerId: ImportProviderId;
  readonly providerVersion: string;
  readonly sourceName: string;
  readonly sourceFingerprint: string;
  readonly suggestedName: string;
  readonly description: string;
  readonly notes: string;
  readonly pathPrefix: string;
  readonly variables: readonly components["schemas"]["VariableWrite"][];
  readonly collections: readonly ImportedCollection[];
  readonly requests: readonly ImportedRequest[];
  readonly diagnostics: readonly ImportDiagnostic[];
}

/** Converts one supported source into a canonical import plan without mutation. */
export interface ImportProvider {
  readonly manifest: ImportProviderManifest;
  probe(source: ImportSource): ImportProbeResult;
  parse(
    source: ImportSource,
  ):
    | Omit<ImportPlan, "sourceFingerprint">
    | Promise<Omit<ImportPlan, "sourceFingerprint">>;
}

/** Lists the extension providers available to backend-only plugins. */
export interface BackendPluginProviders {
  readonly "request.import": ImportProvider;
}

export type BackendPluginModule =
  APInteractPluginModule<BackendPluginProviders>;
