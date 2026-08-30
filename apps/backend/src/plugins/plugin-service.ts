import type {
  EnabledPlugin,
  PluginPackageManifest,
} from "@apinteract/plugin-api";

import type { BackendPluginHost } from "./backend-plugin-host.js";
import type { DiscoveredPluginPackage } from "./plugin-discovery.js";

/** Describes one browser-loadable frontend package through a content address. */
export interface FrontendPluginCatalogEntry {
  readonly manifest: PluginPackageManifest<"frontend">;
  readonly source: "built-in" | "user";
  readonly moduleUrl: string;
}

/** Contains one immutable browser asset and its explicit response media type. */
export interface FrontendPluginAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/** Owns enabled metadata and immutable browser plugin assets. */
export class PluginService {
  readonly #backend: BackendPluginHost;
  readonly #frontend = new Map<string, DiscoveredPluginPackage>();

  constructor(
    backend: BackendPluginHost,
    discovered: readonly DiscoveredPluginPackage[],
  ) {
    this.#backend = backend;
    for (const plugin of discovered) {
      if (plugin.manifest.target === "frontend") {
        this.#frontend.set(plugin.manifest.id, plugin);
      }
    }
  }

  /** Lists backend packages that completed executable registration. */
  backendPlugins(): readonly EnabledPlugin[] {
    return this.#backend.list();
  }

  /** Lists validated frontend packages with immutable same-origin URLs. */
  frontendCatalog(): readonly FrontendPluginCatalogEntry[] {
    return [...this.#frontend.values()].map((plugin) => ({
      manifest: plugin.manifest as PluginPackageManifest<"frontend">,
      source: plugin.source,
      moduleUrl: `/plugins/${encodeURIComponent(plugin.manifest.id)}/${plugin.contentHash}/${plugin.manifest.entrypoint.slice("dist/".length)}`,
    }));
  }

  /** Returns an asset only when its package ID and full-distribution hash match. */
  frontendAsset(
    id: string,
    hash: string,
    assetPath: string,
  ): FrontendPluginAsset | undefined {
    const plugin = this.#frontend.get(id);
    if (plugin?.contentHash !== hash) return undefined;
    const bytes = plugin.assets.get(assetPath);
    return bytes === undefined
      ? undefined
      : { bytes, contentType: pluginAssetContentType(assetPath) };
  }
}

/** Selects a safe explicit media type for one package-relative asset path. */
function pluginAssetContentType(assetPath: string): string {
  const extension = assetPath.slice(assetPath.lastIndexOf(".")).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return types[extension] ?? "application/octet-stream";
}
