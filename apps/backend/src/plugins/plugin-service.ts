import type {
  AuthProviderPluginPackageManifest,
  EnabledPlugin,
  PluginPackageManifest,
} from "@apinteract/plugin-api";
import type { AuthProviderPublicDescriptor } from "@apinteract/plugin-api/backend/authentication";

import type { BackendPluginHost } from "./backend-plugin-host.js";
import type { DiscoveredPluginPackage } from "./plugin-discovery.js";

/** Describes one browser-loadable frontend package through a content address. */
export interface FrontendPluginCatalogEntry {
  readonly manifest: PluginPackageManifest<"frontend">;
  readonly source: "built-in" | "user";
  readonly moduleUrl: string;
}

/** Describes one configured built-in auth frontend through a safe descriptor. */
export interface AuthProviderPluginCatalogEntry {
  readonly manifest: AuthProviderPluginPackageManifest;
  readonly descriptor: AuthProviderPublicDescriptor;
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
  readonly #authentication = new Map<string, DiscoveredPluginPackage>();

  constructor(
    backend: BackendPluginHost,
    discovered: readonly DiscoveredPluginPackage[],
  ) {
    this.#backend = backend;
    for (const plugin of discovered) {
      if (plugin.manifest.target === "frontend") {
        this.#frontend.set(plugin.manifest.id, plugin);
      } else if (plugin.manifest.target === "auth-provider") {
        this.#authentication.set(plugin.manifest.id, plugin);
      }
    }
  }

  /** Lists only configured built-in authentication frontend contributions. */
  authProviderCatalog(
    descriptors: readonly AuthProviderPublicDescriptor[],
  ): readonly AuthProviderPluginCatalogEntry[] {
    return descriptors.map((descriptor) => {
      const plugin = this.#authentication.get(descriptor.pluginId);
      if (plugin === undefined || plugin.manifest.target !== "auth-provider") {
        throw new Error(
          `Configured authentication plugin is unavailable: ${descriptor.pluginId}`,
        );
      }
      const entrypoint = plugin.manifest.entrypoints.frontend;
      return {
        manifest: plugin.manifest,
        descriptor,
        moduleUrl: `/auth/plugins/${encodeURIComponent(plugin.manifest.id)}/${plugin.contentHash}/${entrypoint.slice("dist/".length)}`,
      };
    });
  }

  /** Lists backend packages that completed executable registration. */
  backendPlugins(): readonly EnabledPlugin[] {
    return this.#backend.list();
  }

  /** Lists validated frontend packages with immutable same-origin URLs. */
  frontendCatalog(): readonly FrontendPluginCatalogEntry[] {
    return [...this.#frontend.values()].map((plugin) => {
      const manifest = plugin.manifest as PluginPackageManifest<"frontend">;
      return {
        manifest,
        source: plugin.source,
        moduleUrl: `/plugins/${encodeURIComponent(manifest.id)}/${plugin.contentHash}/${manifest.entrypoint.slice("dist/".length)}`,
      };
    });
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

  /** Returns an auth asset only for a built-in bundle and exact content hash. */
  authProviderAsset(
    id: string,
    hash: string,
    assetPath: string,
  ): FrontendPluginAsset | undefined {
    const plugin = this.#authentication.get(id);
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
