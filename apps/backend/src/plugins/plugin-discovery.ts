import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginPackageManifest,
  type PluginSource,
  type PluginTarget,
} from "@apinteract/plugin-api";
import type { BackendPluginModule } from "@apinteract/plugin-api/backend";
import type { AuthProviderBackendPluginModule } from "@apinteract/plugin-api/backend/authentication";

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
  /** Backend entrypoint for auth bundles and sole entrypoint for schema-v1 packages. */
  readonly entrypointPath: string;
  readonly frontendEntrypointPath?: string;
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

/** Dynamically imports one validated built-in auth-provider backend entrypoint. */
export async function loadAuthProviderBackendModule(
  plugin: DiscoveredPluginPackage,
): Promise<AuthProviderBackendPluginModule> {
  if (plugin.manifest.target !== "auth-provider") {
    throw new Error(
      `Cannot load ${plugin.manifest.target} plugin as authentication`,
    );
  }
  const module = (await import(
    `${pathToFileURL(plugin.entrypointPath).href}?sha256=${plugin.contentHash}`
  )) as Record<string, unknown>;
  if (typeof module.register !== "function") {
    throw new Error(`Plugin ${plugin.manifest.id} does not export register`);
  }
  return {
    register: module.register as AuthProviderBackendPluginModule["register"],
  };
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
  if (manifest.target === "auth-provider" && source !== "built-in") {
    throw new Error("Authentication provider bundles must be built in");
  }
  validatePackageMetadata(
    JSON.parse(
      await readFile(resolve(canonicalPackagePath, "package.json"), "utf8"),
    ) as unknown,
    manifest,
  );
  const entrypointPath = await resolveEntrypoint(
    canonicalPackagePath,
    manifest.target === "auth-provider"
      ? manifest.entrypoints.backend
      : manifest.entrypoint,
  );
  const frontendEntrypointPath =
    manifest.target === "auth-provider"
      ? await resolveEntrypoint(
          canonicalPackagePath,
          manifest.entrypoints.frontend,
        )
      : undefined;
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
    ...(frontendEntrypointPath === undefined ? {} : { frontendEntrypointPath }),
    contentHash: contentHash.digest("hex"),
    assets,
  };
}

/** Resolves one declared entrypoint while rejecting traversal through links. */
async function resolveEntrypoint(
  packagePath: string,
  entrypoint: string,
): Promise<string> {
  const entrypointPath = await realpath(resolve(packagePath, entrypoint));
  const relativeEntrypoint = relative(packagePath, entrypointPath);
  if (
    relativeEntrypoint.startsWith(`..${sep}`) ||
    relativeEntrypoint === ".." ||
    isAbsolute(relativeEntrypoint)
  ) {
    throw new Error("Plugin entrypoint escapes its package directory");
  }
  return entrypointPath;
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
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error("Plugin manifest apiVersion must be 1");
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
  if (manifest.target === "auth-provider") {
    return validateAuthProviderManifest(manifest);
  }
  return validateSingleTargetManifest(manifest);
}

/** Validates the target-specific fields of one schema-v1 manifest. */
function validateSingleTargetManifest(
  manifest: Record<string, unknown>,
): PluginPackageManifest<"frontend" | "backend"> {
  const target = manifest.target;
  const providers = manifest.providers;
  if (manifest.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Single-target plugin manifest schemaVersion must be 1");
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
    id: manifest.id as string,
    name: manifest.name as string,
    version: manifest.version as string,
    ...(typeof manifest.weight === "number" ? { weight: manifest.weight } : {}),
    target: target as PluginTarget,
    entrypoint: manifest.entrypoint,
    providers: providers as string[],
  };
}

/** Validates an atomic, built-in auth-provider runtime pair. */
function validateAuthProviderManifest(
  manifest: Record<string, unknown>,
): PluginPackageManifest<"auth-provider"> {
  if (manifest.schemaVersion !== AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Auth-provider plugin manifest schemaVersion must be 2");
  }
  const entrypoints = manifest.entrypoints;
  const providers = manifest.providers;
  if (
    !isRecord(entrypoints) ||
    !validEntrypoint(entrypoints.backend) ||
    !validEntrypoint(entrypoints.frontend) ||
    entrypoints.backend === entrypoints.frontend
  ) {
    throw new Error("Auth-provider plugin manifest has invalid entrypoints");
  }
  if (
    !isRecord(providers) ||
    !exactProviders(providers.backend, "authentication.provider") ||
    !exactProviders(providers.frontend, "authentication.login")
  ) {
    throw new Error("Auth-provider plugin manifest has invalid providers");
  }
  return {
    schemaVersion: AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    id: manifest.id as string,
    name: manifest.name as string,
    version: manifest.version as string,
    ...(typeof manifest.weight === "number" ? { weight: manifest.weight } : {}),
    target: "auth-provider",
    entrypoints: {
      backend: entrypoints.backend,
      frontend: entrypoints.frontend,
    },
    providers: {
      backend: ["authentication.provider"],
      frontend: ["authentication.login"],
    },
  };
}

/** Reports whether one untrusted manifest value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Applies the common package-relative JavaScript entrypoint rules. */
function validEntrypoint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    entrypointPattern.test(value) &&
    !value.includes("../")
  );
}

/** Requires exactly one declared auth capability on each runtime side. */
function exactProviders(value: unknown, provider: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === provider;
}

/** Detects only ordinary absent-path filesystem failures. */
function isMissingPath(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as Error & { code?: unknown }).code === "ENOENT"
  );
}
