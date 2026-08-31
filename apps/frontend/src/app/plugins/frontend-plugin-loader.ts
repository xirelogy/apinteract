import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginPackageManifest,
  type PluginSource,
} from "@apinteract/plugin-api";
import type { FrontendPluginModule } from "@apinteract/plugin-api/frontend";

import type { FrontendPluginRuntime } from "@/app/plugins/frontend-plugin-host";

interface FrontendPluginCatalogEntry {
  readonly manifest: PluginPackageManifest<"frontend">;
  readonly source: PluginSource;
  readonly moduleUrl: string;
}

/** Loads discovered same-origin frontend packages before application mount. */
export async function loadFrontendPlugins(
  runtime: FrontendPluginRuntime,
): Promise<void> {
  const response = await fetch("/plugins/catalog.json", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Frontend plugin catalog returned HTTP ${response.status}`);
  }
  const entries = parseCatalog(await response.json());
  for (const entry of entries) {
    try {
      const imported = (await import(
        /* @vite-ignore */ entry.moduleUrl
      )) as Record<string, unknown>;
      if (typeof imported.register !== "function") {
        throw new Error("Entrypoint does not export register");
      }
      runtime.plugins.install(
        entry.manifest,
        { register: imported.register as FrontendPluginModule["register"] },
        entry.source,
      );
    } catch (cause) {
      console.error(`Ignoring frontend plugin ${entry.manifest.id}`, cause);
    }
  }
  runtime.plugins.validateCapabilities();
}

/** Validates the untrusted catalog returned by the backend. */
function parseCatalog(value: unknown): readonly FrontendPluginCatalogEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Frontend plugin catalog must be an object");
  }
  const plugins = (value as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) {
    throw new Error("Frontend plugin catalog requires a plugins array");
  }
  return plugins.map(parseCatalogEntry);
}

/** Validates one catalog entry and its same-origin content-addressed URL. */
function parseCatalogEntry(value: unknown): FrontendPluginCatalogEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Frontend plugin catalog entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  if (
    manifest === undefined ||
    manifest.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION ||
    manifest.apiVersion !== PLUGIN_API_VERSION ||
    manifest.target !== "frontend" ||
    typeof manifest.id !== "string" ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    (manifest.weight !== undefined &&
      (typeof manifest.weight !== "number" ||
        !Number.isSafeInteger(manifest.weight) ||
        manifest.weight < -10000 ||
        manifest.weight > 10000)) ||
    typeof manifest.entrypoint !== "string" ||
    !Array.isArray(manifest.providers) ||
    !manifest.providers.every((provider) => typeof provider === "string")
  ) {
    throw new Error("Frontend plugin catalog entry has an invalid manifest");
  }
  if (entry.source !== "built-in" && entry.source !== "user") {
    throw new Error("Frontend plugin catalog entry has an invalid source");
  }
  if (
    typeof entry.moduleUrl !== "string" ||
    !isContentAddressedPluginModuleUrl(entry.moduleUrl)
  ) {
    throw new Error("Frontend plugin catalog entry has an invalid module URL");
  }
  return {
    manifest: manifest as unknown as PluginPackageManifest<"frontend">,
    source: entry.source,
    moduleUrl: entry.moduleUrl,
  };
}

/** Accepts only same-origin module paths nested below an immutable package hash. */
function isContentAddressedPluginModuleUrl(value: string): boolean {
  const segments = value.split("/");
  if (
    segments.length < 5 ||
    segments[0] !== "" ||
    segments[1] !== "plugins" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(segments[2] ?? "") ||
    !/^[a-f0-9]{64}$/u.test(segments[3] ?? "")
  ) {
    return false;
  }
  const assetSegments = segments.slice(4);
  return (
    assetSegments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/u.test(segment),
    ) && /\.(?:js|mjs)$/u.test(assetSegments.at(-1) ?? "")
  );
}
