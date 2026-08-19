import { createHash } from "node:crypto";

import {
  type ImportDiagnostic,
  ImportSourceError,
  type ImportedCollection,
  type ImportedRequest,
  type ImportPlan,
  type ImportProvider,
  type ImportProviderId,
  type ImportProviderManifest,
  type ImportSource,
} from "./import-types.js";
import type { VariableWrite } from "../variables/variable-profile-store.js";

export const MAX_IMPORT_SOURCE_BYTES = 524_288;
export const MAX_IMPORT_REQUESTS = 200;

/** Registers source adapters and owns deterministic detection and plan validation. */
export class ImportProviderRegistry {
  readonly #providers = new Map<ImportProviderId, ImportProvider>();

  constructor(providers: readonly ImportProvider[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.manifest.id)) {
        throw new Error(`Duplicate import provider ${provider.manifest.id}`);
      }
      this.#providers.set(provider.manifest.id, provider);
    }
  }

  /** Lists public provider metadata in registration order. */
  manifests(): readonly ImportProviderManifest[] {
    return [...this.#providers.values()].map((provider) => provider.manifest);
  }

  /** Detects or selects a provider and returns one validated canonical plan. */
  async preview(
    providerId: ImportProviderId | null,
    source: ImportSource,
  ): Promise<ImportPlan> {
    validateSource(source);
    const provider =
      providerId === null
        ? this.#detect(source)
        : this.#providers.get(providerId);
    if (provider === undefined) {
      throw new ImportSourceError(
        "import_provider_not_found",
        "The selected import provider is not available.",
      );
    }
    const plan = await provider.parse(source);
    if (plan.providerId !== provider.manifest.id) {
      throw new Error("Import provider returned a mismatched provider ID");
    }
    if (plan.requests.length > MAX_IMPORT_REQUESTS) {
      throw new ImportSourceError(
        "import_too_many_requests",
        `The source contains more than ${MAX_IMPORT_REQUESTS} requests.`,
      );
    }
    const itemIds = new Set(plan.requests.map((request) => request.itemId));
    if (itemIds.size !== plan.requests.length) {
      throw new Error("Import provider returned duplicate item IDs");
    }
    validateCollections(plan.collections, plan.requests);
    const normalizedPlan = normalizeImportVariables(plan);
    return {
      ...normalizedPlan,
      diagnostics: groupDiagnostics(normalizedPlan.diagnostics),
      sourceFingerprint: fingerprintSource(source),
    };
  }

  /** Selects the single highest-confidence provider above the recognition floor. */
  #detect(source: ImportSource): ImportProvider {
    const candidates = [...this.#providers.values()]
      .map((provider) => ({ provider, probe: provider.probe(source) }))
      .filter((candidate) => candidate.probe.confidence >= 0.5)
      .sort((left, right) => right.probe.confidence - left.probe.confidence);
    const first = candidates[0];
    if (first === undefined) {
      throw new ImportSourceError(
        "import_format_unrecognized",
        "The import format could not be recognized.",
      );
    }
    const second = candidates[1];
    if (
      second !== undefined &&
      Math.abs(first.probe.confidence - second.probe.confidence) < 0.05
    ) {
      throw new ImportSourceError(
        "import_format_ambiguous",
        "More than one import provider recognized the source.",
      );
    }
    return first.provider;
  }
}

/** Validates provider collection identities, ancestry, and request routing. */
function validateCollections(
  collections: readonly ImportedCollection[],
  requests: readonly ImportedRequest[],
): void {
  const keys = new Set(
    collections.map((collection) => collection.collectionKey),
  );
  if (keys.size !== collections.length || keys.has("")) {
    throw new Error("Import provider returned invalid collection keys");
  }
  for (const collection of collections) {
    if (
      collection.parentCollectionKey !== null &&
      !keys.has(collection.parentCollectionKey)
    ) {
      throw new Error("Import provider returned an unknown collection parent");
    }
    const ancestors = new Set<string>([collection.collectionKey]);
    let parentKey = collection.parentCollectionKey;
    while (parentKey !== null) {
      if (ancestors.has(parentKey)) {
        throw new Error("Import provider returned a collection cycle");
      }
      ancestors.add(parentKey);
      parentKey =
        collections.find((candidate) => candidate.collectionKey === parentKey)
          ?.parentCollectionKey ?? null;
    }
  }
  if (
    requests.some(
      (request) =>
        request.collectionKey !== null && !keys.has(request.collectionKey),
    )
  ) {
    throw new Error(
      "Import provider routed a request to an unknown collection",
    );
  }
}

/** Lifts each request variable baseline to its nearest imported collection. */
function normalizeImportVariables(
  plan: Omit<ImportPlan, "sourceFingerprint">,
): Omit<ImportPlan, "sourceFingerprint"> {
  const scopeVariables = new Map<string | null, VariableWrite[]>();
  scopeVariables.set(null, [...plan.variables]);
  for (const collection of plan.collections) {
    scopeVariables.set(collection.collectionKey, [...collection.variables]);
  }
  const requestsByScope = new Map<string | null, ImportedRequest[]>();
  for (const request of plan.requests) {
    const scoped = requestsByScope.get(request.collectionKey) ?? [];
    scoped.push(request);
    requestsByScope.set(request.collectionKey, scoped);
  }
  const normalizedRequests = new Map<string, ImportedRequest>();
  for (const [scopeKey, requests] of requestsByScope) {
    const localBaselines = scopeVariables.get(scopeKey) ?? [];
    const inheritedBaselines = inheritedScopeVariables(
      scopeKey,
      plan.collections,
      scopeVariables,
    );
    const inheritedByName = new Map(
      inheritedBaselines.map((variable) => [variable.name, variable] as const),
    );
    const localByName = new Map(
      localBaselines.map((variable) => [variable.name, variable] as const),
    );
    const candidates = new Map<
      string,
      {
        variable: VariableWrite;
        signature: string;
        count: number;
        order: number;
      }[]
    >();
    let order = 0;
    for (const request of requests) {
      for (const variable of request.variables) {
        const signature = variableSignature(variable);
        const named = candidates.get(variable.name) ?? [];
        const existing = named.find(
          (candidate) => candidate.signature === signature,
        );
        if (existing === undefined) {
          named.push({ variable, signature, count: 1, order });
        } else {
          existing.count += 1;
        }
        candidates.set(variable.name, named);
        order += 1;
      }
    }
    for (const [name, named] of candidates) {
      if (localByName.has(name)) continue;
      const selected = [...named].sort(
        (left, right) => right.count - left.count || left.order - right.order,
      )[0];
      const inherited = inheritedByName.get(name);
      if (
        selected !== undefined &&
        (inherited === undefined ||
          variableSignature(inherited) !== selected.signature)
      ) {
        localBaselines.push(selected.variable);
        localByName.set(name, selected.variable);
      }
    }
    scopeVariables.set(scopeKey, localBaselines);
    const effectiveByName = new Map(inheritedByName);
    for (const variable of localBaselines) {
      effectiveByName.set(variable.name, variable);
    }
    for (const request of requests) {
      normalizedRequests.set(request.itemId, {
        ...request,
        variables: request.variables.filter((variable) => {
          const baseline = effectiveByName.get(variable.name);
          return (
            baseline === undefined ||
            variableSignature(baseline) !== variableSignature(variable)
          );
        }),
      });
    }
  }
  return {
    ...plan,
    variables: scopeVariables.get(null) ?? [],
    collections: plan.collections.map((collection) => ({
      ...collection,
      variables: scopeVariables.get(collection.collectionKey) ?? [],
    })),
    requests: plan.requests.map(
      (request) => normalizedRequests.get(request.itemId) ?? request,
    ),
  };
}

/** Returns root-to-parent variables inherited by one imported collection scope. */
function inheritedScopeVariables(
  scopeKey: string | null,
  collections: readonly ImportedCollection[],
  scopeVariables: Map<string | null, VariableWrite[]>,
): VariableWrite[] {
  const collectionByKey = new Map(
    collections.map((collection) => [collection.collectionKey, collection]),
  );
  const ancestorKeys: string[] = [];
  let parentKey =
    scopeKey === null
      ? null
      : (collectionByKey.get(scopeKey)?.parentCollectionKey ?? null);
  while (parentKey !== null) {
    ancestorKeys.push(parentKey);
    parentKey = collectionByKey.get(parentKey)?.parentCollectionKey ?? null;
  }
  const effective = new Map<string, VariableWrite>();
  for (const variable of scopeVariables.get(null) ?? []) {
    effective.set(variable.name, variable);
  }
  for (const key of ancestorKeys.reverse()) {
    for (const variable of scopeVariables.get(key) ?? []) {
      effective.set(variable.name, variable);
    }
  }
  return [...effective.values()];
}

/** Produces an internal comparison key without exposing variable contents. */
function variableSignature(variable: VariableWrite): string {
  if (variable.kind === "value")
    return JSON.stringify(["value", variable.value]);
  if (variable.kind === "alias")
    return JSON.stringify(["alias", variable.target]);
  if (variable.kind === "secret") {
    return JSON.stringify([
      "secret",
      variable.value === undefined ? 0 : 1,
      variable.value ?? "",
      variable.clearValue ?? false,
    ]);
  }
  return "unset";
}

/** Coalesces exact repeated notes while preserving every affected item and location. */
function groupDiagnostics(
  diagnostics: readonly ImportDiagnostic[],
): readonly ImportDiagnostic[] {
  const groups = new Map<string, ImportDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.severity}\u0000${diagnostic.message}`;
    const group = groups.get(key) ?? [];
    group.push(diagnostic);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const itemIds = uniqueStrings(
      group.flatMap((entry) => [entry.itemId, ...(entry.itemIds ?? [])]),
    );
    const sourceLocations = uniqueStrings(
      group.flatMap((entry) => [
        entry.sourceLocation,
        ...(entry.sourceLocations ?? []),
      ]),
    );
    if (group.length === 1) return first;
    return {
      code: first.code,
      severity: first.severity,
      message: first.message,
      ...(itemIds.length === 0 ? {} : { itemIds }),
      ...(sourceLocations.length === 0 ? {} : { sourceLocations }),
    };
  });
}

/** Deduplicates optional strings while retaining their first-seen order. */
function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ];
}

/** Validates the common source boundary before providers inspect its contents. */
function validateSource(source: ImportSource): void {
  if (source.name.length === 0 || source.name.length > 255) {
    throw new ImportSourceError(
      "import_source_invalid",
      "The source name must contain between 1 and 255 characters.",
    );
  }
  const sourceBytes = Buffer.byteLength(source.text, "utf8");
  if (sourceBytes === 0 || sourceBytes > MAX_IMPORT_SOURCE_BYTES) {
    throw new ImportSourceError(
      "import_source_invalid",
      `The source must contain between 1 and ${MAX_IMPORT_SOURCE_BYTES} UTF-8 bytes.`,
    );
  }
}

/** Produces the replay guard used when an apply command re-parses a previewed source. */
function fingerprintSource(source: ImportSource): string {
  return createHash("sha256")
    .update(source.name)
    .update("\0")
    .update(source.text)
    .digest("hex");
}
