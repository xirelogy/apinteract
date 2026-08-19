import type { EntityId } from "../foundation/id.js";
import type { RequestService } from "../requests/request-service.js";
import { HarImportProvider } from "./har-provider.js";
import { ImportProviderRegistry } from "./import-provider-registry.js";
import {
  type ImportApplyInput,
  type ImportApplyResult,
  type ImportPlan,
  type ImportProviderId,
  type ImportProviderManifest,
  type ImportSource,
  ImportSourceError,
} from "./import-types.js";
import { OpenApiJsonImportProvider } from "./openapi-json-provider.js";

/** Coordinates provider parsing and delegates all persistent writes atomically. */
export class ImportService {
  readonly #registry: ImportProviderRegistry;
  readonly #requests: RequestService;

  constructor(
    requests: RequestService,
    registry = new ImportProviderRegistry([
      new OpenApiJsonImportProvider(),
      new HarImportProvider(),
    ]),
  ) {
    this.#requests = requests;
    this.#registry = registry;
  }

  /** Lists installed import providers without exposing executable implementation. */
  providers(): readonly ImportProviderManifest[] {
    return this.#registry.manifests();
  }

  /** Parses one bounded source into a mutation-free preview plan. */
  preview(
    providerId: ImportProviderId | null,
    source: ImportSource,
  ): Promise<ImportPlan> {
    return this.#registry.preview(providerId, source);
  }

  /** Re-parses a previewed source and atomically creates the selected requests. */
  async apply(
    userId: EntityId,
    providerId: ImportProviderId | null,
    source: ImportSource,
    input: ImportApplyInput,
  ): Promise<ImportApplyResult> {
    const plan = await this.#registry.preview(providerId, source);
    if (plan.sourceFingerprint !== input.expectedSourceFingerprint) {
      throw new ImportSourceError(
        "import_source_changed",
        "The import source changed after it was previewed.",
      );
    }
    const selectedIds = new Set(input.selectedItemIds);
    if (
      selectedIds.size === 0 ||
      selectedIds.size !== input.selectedItemIds.length
    ) {
      throw new ImportSourceError(
        "import_selection_invalid",
        "Select at least one unique request to import.",
      );
    }
    const selected = plan.requests.filter((request) =>
      selectedIds.has(request.itemId),
    );
    if (selected.length !== selectedIds.size) {
      throw new ImportSourceError(
        "import_selection_invalid",
        "The import selection contains an unknown request.",
      );
    }
    if (
      plan.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          (diagnostic.itemId === undefined ||
            selectedIds.has(diagnostic.itemId)),
      )
    ) {
      throw new ImportSourceError(
        "import_plan_invalid",
        "The selected requests contain import errors.",
      );
    }
    return this.#requests.importRequests(
      userId,
      input.workspaceId,
      input.parentCollectionId,
      plan.providerId,
      input.collectionName,
      plan.pathPrefix,
      selected,
    );
  }
}
