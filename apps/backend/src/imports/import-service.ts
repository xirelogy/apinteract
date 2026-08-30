import type { EntityId } from "../foundation/id.js";
import { createBackendPluginRuntime } from "../plugins/backend-plugin-host.js";
import type { RequestService } from "../requests/request-service.js";
import type { ImportProviderRegistry } from "./import-provider-registry.js";
import {
  type ImportApplyInput,
  type ImportApplyResult,
  type ImportPlan,
  type ImportProviderId,
  type ImportProviderManifest,
  type ImportSource,
  ImportSourceError,
} from "./import-types.js";

/** Coordinates provider parsing and delegates all persistent writes atomically. */
export class ImportService {
  readonly #registry: ImportProviderRegistry;
  readonly #requests: RequestService;

  constructor(
    requests: RequestService,
    registry = createBackendPluginRuntime().imports,
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
          diagnosticAffectsSelection(diagnostic, selectedIds),
      )
    ) {
      throw new ImportSourceError(
        "import_plan_invalid",
        "The selected requests contain import errors.",
      );
    }
    const selectedPlan = selectPlanContent(plan, selected);
    return this.#requests.importRequests(
      userId,
      input.workspaceId,
      input.parentCollectionId,
      {
        providerId: plan.providerId,
        collectionName: input.collectionName,
        description: plan.description,
        notes: plan.notes,
        pathPrefix: plan.pathPrefix,
        variables: selectedPlan.variables,
        collections: selectedPlan.collections,
        requests: selected,
      },
    );
  }
}

/** Reports whether a global, singular, or grouped diagnostic blocks a selection. */
function diagnosticAffectsSelection(
  diagnostic: ImportPlan["diagnostics"][number],
  selectedIds: ReadonlySet<string>,
): boolean {
  if (diagnostic.itemId !== undefined)
    return selectedIds.has(diagnostic.itemId);
  if (diagnostic.itemIds !== undefined) {
    return diagnostic.itemIds.some((itemId) => selectedIds.has(itemId));
  }
  return true;
}

/** Retains only selected collection branches and variables they can reference. */
function selectPlanContent(
  plan: ImportPlan,
  selected: readonly ImportPlan["requests"][number][],
): Pick<ImportPlan, "variables" | "collections"> {
  const collectionByKey = new Map(
    plan.collections.map((collection) => [
      collection.collectionKey,
      collection,
    ]),
  );
  const retainedKeys = new Set<string>();
  for (const request of selected) {
    let key = request.collectionKey;
    while (key !== null && !retainedKeys.has(key)) {
      retainedKeys.add(key);
      key = collectionByKey.get(key)?.parentCollectionKey ?? null;
    }
  }
  const collections = plan.collections
    .filter((collection) => retainedKeys.has(collection.collectionKey))
    .map((collection) => ({
      ...collection,
      variables: collection.variables.filter((variable) =>
        baselineVariableRequired(
          variable.name,
          collection.collectionKey,
          plan.pathPrefix,
          selected,
          collectionByKey,
        ),
      ),
    }));
  return {
    variables: plan.variables.filter((variable) =>
      baselineVariableRequired(
        variable.name,
        null,
        plan.pathPrefix,
        selected,
        collectionByKey,
      ),
    ),
    collections,
  };
}

/** Retains a baseline only when a selected descendant uses it without an override. */
function baselineVariableRequired(
  name: string,
  scopeKey: string | null,
  rootPathPrefix: string,
  selected: readonly ImportPlan["requests"][number][],
  collectionByKey: ReadonlyMap<string, ImportPlan["collections"][number]>,
): boolean {
  return selected.some((request) => {
    const chain = requestCollectionChain(request, collectionByKey);
    const scopeIndex =
      scopeKey === null
        ? -1
        : chain.findIndex(
            (collection) => collection.collectionKey === scopeKey,
          );
    if (scopeKey !== null && scopeIndex < 0) return false;
    const searchText = [
      rootPathPrefix,
      ...chain.map((collection) => collection.pathPrefix),
      requestSearchText(request),
    ].join("\u0000");
    if (!interpolationReferences(searchText, name)) return false;
    const nearerCollections = chain.slice(scopeIndex + 1);
    return (
      !nearerCollections.some((collection) =>
        collection.variables.some((variable) => variable.name === name),
      ) && !request.variables.some((variable) => variable.name === name)
    );
  });
}

/** Returns imported collection ancestry from root-most to nearest. */
function requestCollectionChain(
  request: ImportPlan["requests"][number],
  collectionByKey: ReadonlyMap<string, ImportPlan["collections"][number]>,
): ImportPlan["collections"][number][] {
  const reversed: ImportPlan["collections"][number][] = [];
  let key = request.collectionKey;
  while (key !== null) {
    const collection = collectionByKey.get(key);
    if (collection === undefined) break;
    reversed.push(collection);
    key = collection.parentCollectionKey;
  }
  return reversed.reverse();
}

/** Serializes interpolation-capable request fields without captured response data. */
function requestSearchText(request: ImportPlan["requests"][number]): string {
  return JSON.stringify({
    targetUrl: request.targetUrl,
    query: request.query,
    headers: request.headers,
    requestBody: request.requestBody,
    body: request.body,
    preRequestScript: request.preRequestScript,
    postResponseScript: request.postResponseScript,
  });
}

/** Checks an exact APInteract interpolation reference without regex escaping. */
function interpolationReferences(text: string, name: string): boolean {
  return text.includes(`<<${name}>>`);
}
