import type {
  HttpMethod,
  RequestBodyDefinition,
  RequestField,
  RequestView,
} from "../requests/request-service.js";
import type { VariableWrite } from "../variables/variable-profile-store.js";

export type ImportProviderId = "openapi-json" | "har";

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
  readonly variables: readonly VariableWrite[];
}

/** Preserves one recorded HTTP response without claiming it was executed here. */
export interface CapturedExchangeView {
  readonly capturedExchangeId?: string;
  readonly source: "har";
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
  readonly method: HttpMethod;
  readonly targetMode: "absolute" | "composed";
  readonly targetUrl: string;
  readonly query: readonly RequestField[];
  readonly headers: readonly RequestField[];
  readonly requestBody: RequestBodyDefinition;
  readonly body: string;
  readonly preRequestScript: string;
  readonly postResponseScript: string;
  readonly variables: readonly VariableWrite[];
  readonly capturedExchange?: CapturedExchangeView;
}

/** Versioned, source-neutral preview returned before any persistent mutation. */
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
  readonly variables: readonly VariableWrite[];
  readonly collections: readonly ImportedCollection[];
  readonly requests: readonly ImportedRequest[];
  readonly diagnostics: readonly ImportDiagnostic[];
}

/** Applies selected normalized requests under one newly created collection. */
export interface ImportApplyInput {
  readonly workspaceId: string;
  readonly parentCollectionId: string | null;
  readonly collectionName: string;
  readonly selectedItemIds: readonly string[];
  readonly expectedSourceFingerprint: string;
}

/** Identifies one collection and its parent in a persisted import hierarchy. */
export interface ImportedCollectionResult {
  readonly collectionId: string;
  readonly parentCollectionId: string | null;
}

/** Identifies the entities created by one atomic persisted import. */
export interface ImportApplyResult {
  readonly collectionId: string;
  readonly collections: readonly ImportedCollectionResult[];
  readonly requests: readonly RequestView[];
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

/** Raised when source selection or canonical import validation cannot continue. */
export class ImportSourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
