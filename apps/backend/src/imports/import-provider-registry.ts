import { createHash } from "node:crypto";

import {
  ImportSourceError,
  type ImportPlan,
  type ImportProvider,
  type ImportProviderId,
  type ImportProviderManifest,
  type ImportSource,
} from "./import-types.js";

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
    return { ...plan, sourceFingerprint: fingerprintSource(source) };
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
