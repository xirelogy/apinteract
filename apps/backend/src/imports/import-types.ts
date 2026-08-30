import type { RequestView } from "../requests/request-service.js";

export type {
  CapturedExchangeView,
  ImportDiagnostic,
  ImportDiagnosticSeverity,
  ImportedCollection,
  ImportedRequest,
  ImportPlan,
  ImportProvider,
  ImportProviderId,
  ImportProviderManifest,
  ImportProbeResult,
  ImportSource,
} from "@apinteract/plugin-api/backend";

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

/** Raised when source selection or canonical import validation cannot continue. */
export class ImportSourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
