import type {
  EnabledPlugin,
  PluginPackageManifest,
  PluginSource,
} from "@apinteract/plugin-api";
import type {
  BackendPluginModule,
  ImportProvider,
} from "@apinteract/plugin-api/backend";

import { ImportProviderRegistry } from "../imports/import-provider-registry.js";

/** Owns installed backend plugins and commits each package atomically. */
export class BackendPluginHost {
  readonly #imports: ImportProviderRegistry;
  readonly #installed = new Map<string, EnabledPlugin>();

  constructor(imports: ImportProviderRegistry) {
    this.#imports = imports;
  }

  /** Installs one validated backend package without exposing partial work. */
  install(
    manifest: PluginPackageManifest<"backend">,
    plugin: BackendPluginModule,
    source: PluginSource,
  ): void {
    if (this.#installed.has(manifest.id)) {
      throw new Error(`Backend plugin is already installed: ${manifest.id}`);
    }
    const imports: ImportProvider[] = [];
    plugin.register({
      register: (provider, contribution) => {
        if (!manifest.providers.includes(provider)) {
          throw new Error(
            `Backend plugin ${manifest.id} did not declare provider ${provider}`,
          );
        }
        if (provider !== "request.import") {
          throw new Error(
            `Unsupported backend plugin provider: ${String(provider)}`,
          );
        }
        imports.push(contribution);
      },
    });
    if (
      manifest.providers.length !== 1 ||
      manifest.providers[0] !== "request.import"
    ) {
      throw new Error(`Backend plugin ${manifest.id} has invalid providers`);
    }
    if (imports.length === 0) {
      throw new Error(
        `Backend plugin ${manifest.id} registered no request.import contribution`,
      );
    }
    const validation = new ImportProviderRegistry(this.#imports.providers());
    for (const provider of imports) validation.register(provider);
    for (const provider of imports) {
      this.#imports.register(provider, manifest.weight ?? 0);
    }
    this.#installed.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      target: manifest.target,
      source,
    });
  }

  /** Returns successfully installed backend packages in installation order. */
  list(): readonly EnabledPlugin[] {
    return [...this.#installed.values()];
  }

  /** Reports whether one stable plugin ID completed registration. */
  has(pluginId: string): boolean {
    return this.#installed.has(pluginId);
  }

  /** Requires at least one import implementation without naming a package. */
  validateCapabilities(): void {
    if (this.#imports.providers().length === 0) {
      throw new Error("No request import provider is available");
    }
  }
}

/** Groups an initialized backend host with its service-facing registries. */
export interface BackendPluginRuntime {
  readonly plugins: BackendPluginHost;
  readonly imports: ImportProviderRegistry;
}

/** Creates an empty backend runtime populated only through package discovery. */
export function createBackendPluginRuntime(): BackendPluginRuntime {
  const imports = new ImportProviderRegistry();
  const plugins = new BackendPluginHost(imports);
  return { plugins, imports };
}
