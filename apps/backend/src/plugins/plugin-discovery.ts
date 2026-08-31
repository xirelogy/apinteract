import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginPackageManifest,
  type PluginSource,
  type PluginTarget,
} from "@apinteract/plugin-api";
import type { BackendPluginModule } from "@apinteract/plugin-api/backend";

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const entrypointPattern = /^dist\/[A-Za-z0-9._/-]+\.(?:js|mjs)$/u;
const MAX_PLUGIN_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_DISTRIBUTION_BYTES = 32 * 1024 * 1024;

/** Identifies one directory scanned with a host-injected source class. */
export interface PluginDiscoveryRoot {
  readonly path: string;
  readonly source: PluginSource;
}

/** Retains validated paths and bytes needed by one runtime loader. */
export interface DiscoveredPluginPackage {
  readonly manifest: PluginPackageManifest;
  readonly source: PluginSource;
  readonly packagePath: string;
  readonly entrypointPath: string;
  readonly contentHash: string;
  readonly assets: ReadonlyMap<string, Buffer>;
}

/** Scans equivalent built-in and user roots using one strict package format. */
export async function discoverPluginPackages(
  roots: readonly PluginDiscoveryRoot[],
  reportInvalid: (path: string, cause: unknown) => void,
): Promise<readonly DiscoveredPluginPackage[]> {
  const discovered: DiscoveredPluginPackage[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (cause) {
      if (isMissingPath(cause)) continue;
      throw cause;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory()) continue;
      const packagePath = resolve(root.path, entry.name);
      try {
        discovered.push(await readPluginPackage(packagePath, root.source));
      } catch (cause) {
        reportInvalid(packagePath, cause);
      }
    }
  }
  const ids = new Set<string>();
  for (const plugin of discovered) {
    if (ids.has(plugin.manifest.id)) {
      throw new Error(`Duplicate discovered plugin ID: ${plugin.manifest.id}`);
    }
    ids.add(plugin.manifest.id);
  }
  return discovered;
}

/** Dynamically imports one validated backend entrypoint. */
export async function loadBackendPluginModule(
  plugin: DiscoveredPluginPackage,
): Promise<BackendPluginModule> {
  if (plugin.manifest.target !== "backend") {
    throw new Error(`Cannot load ${plugin.manifest.target} plugin in backend`);
  }
  const module = (await import(
    `${pathToFileURL(plugin.entrypointPath).href}?sha256=${plugin.contentHash}`
  )) as Record<string, unknown>;
  if (typeof module.register !== "function") {
    throw new Error(`Plugin ${plugin.manifest.id} does not export register`);
  }
  return { register: module.register as BackendPluginModule["register"] };
}

/** Reads and validates one package without executing its entrypoint. */
async function readPluginPackage(
  packagePath: string,
  source: PluginSource,
): Promise<DiscoveredPluginPackage> {
  const canonicalPackagePath = await realpath(packagePath);
  const manifestValue = JSON.parse(
    await readFile(
      resolve(canonicalPackagePath, "apinteract-plugin.json"),
      "utf8",
    ),
  ) as unknown;
  const manifest = validatePluginManifest(manifestValue);
  validatePackageMetadata(
    JSON.parse(
      await readFile(resolve(canonicalPackagePath, "package.json"), "utf8"),
    ) as unknown,
    manifest,
  );
  const entrypointPath = await realpath(
    resolve(canonicalPackagePath, manifest.entrypoint),
  );
  const relativeEntrypoint = relative(canonicalPackagePath, entrypointPath);
  if (
    relativeEntrypoint.startsWith(`..${sep}`) ||
    relativeEntrypoint === ".." ||
    isAbsolute(relativeEntrypoint)
  ) {
    throw new Error("Plugin entrypoint escapes its package directory");
  }
  const assets = await readDistributionAssets(
    resolve(canonicalPackagePath, "dist"),
  );
  const contentHash = createHash("sha256");
  for (const [path, bytes] of assets) {
    contentHash.update(path).update("\0").update(bytes).update("\0");
  }
  return {
    manifest,
    source,
    packagePath: canonicalPackagePath,
    entrypointPath,
    contentHash: contentHash.digest("hex"),
    assets,
  };
}

/** Requires package metadata while keeping the plugin manifest canonical. */
function validatePackageMetadata(
  value: unknown,
  manifest: PluginPackageManifest,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin package.json must be an object");
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.name !== "string" ||
    metadata.name.trim() === "" ||
    metadata.version !== manifest.version ||
    metadata.type !== "module"
  ) {
    throw new Error("Plugin package.json metadata does not match its manifest");
  }
}

/** Reads regular distribution files stably and rejects symbolic links. */
async function readDistributionAssets(
  root: string,
): Promise<ReadonlyMap<string, Buffer>> {
  const assets = new Map<string, Buffer>();
  await appendDistributionAssets(root, root, assets, { totalBytes: 0 });
  return assets;
}

/** Appends one distribution subtree while enforcing package resource limits. */
async function appendDistributionAssets(
  root: string,
  directory: string,
  assets: Map<string, Buffer>,
  state: { totalBytes: number },
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error("Plugin distribution cannot contain symbolic links");
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await appendDistributionAssets(root, path, assets, state);
      continue;
    }
    if (!entry.isFile()) continue;
    const assetSize = (await stat(path)).size;
    if (assetSize > MAX_PLUGIN_ASSET_BYTES) {
      throw new Error("Plugin distribution asset exceeds the size limit");
    }
    state.totalBytes += assetSize;
    if (state.totalBytes > MAX_PLUGIN_DISTRIBUTION_BYTES) {
      throw new Error("Plugin distribution exceeds the package size limit");
    }
    const relativePath = relative(root, path).split(sep).join("/");
    assets.set(relativePath, await readFile(path));
  }
}

/** Rejects malformed canonical package metadata at the filesystem boundary. */
export function validatePluginManifest(value: unknown): PluginPackageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  const target = manifest.target;
  const providers = manifest.providers;
  if (
    manifest.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION ||
    manifest.apiVersion !== PLUGIN_API_VERSION
  ) {
    throw new Error(
      "Plugin manifest schemaVersion and apiVersion must both be 1",
    );
  }
  if (typeof manifest.id !== "string" || !pluginIdPattern.test(manifest.id)) {
    throw new Error("Plugin manifest has an invalid ID");
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error("Plugin manifest requires a name");
  }
  if (
    typeof manifest.version !== "string" ||
    !semanticVersionPattern.test(manifest.version)
  ) {
    throw new Error("Plugin manifest has an invalid version");
  }
  if (
    manifest.weight !== undefined &&
    (typeof manifest.weight !== "number" ||
      !Number.isSafeInteger(manifest.weight) ||
      manifest.weight < -10000 ||
      manifest.weight > 10000)
  ) {
    throw new Error("Plugin manifest has an invalid weight");
  }
  if (target !== "frontend" && target !== "backend") {
    throw new Error("Plugin manifest has an invalid target");
  }
  if (
    typeof manifest.entrypoint !== "string" ||
    !entrypointPattern.test(manifest.entrypoint) ||
    manifest.entrypoint.includes("../")
  ) {
    throw new Error("Plugin manifest has an invalid entrypoint");
  }
  if (
    !Array.isArray(providers) ||
    providers.length === 0 ||
    providers.some(
      (provider) => typeof provider !== "string" || provider === "",
    ) ||
    new Set(providers).size !== providers.length
  ) {
    throw new Error("Plugin manifest has invalid providers");
  }
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(typeof manifest.weight === "number" ? { weight: manifest.weight } : {}),
    target: target as PluginTarget,
    entrypoint: manifest.entrypoint,
    providers: providers as string[],
  };
}

/** Detects only ordinary absent-path filesystem failures. */
function isMissingPath(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as Error & { code?: unknown }).code === "ENOENT"
  );
}
