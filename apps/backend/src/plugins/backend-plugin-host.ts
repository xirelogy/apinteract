import type {
  BackendPlugin,
  BackendPluginProviders,
  ImportProvider,
} from "@apinteract/plugin-api/backend";

import { ImportProviderRegistry } from "../imports/import-provider-registry.js";
import { builtinImportPlugin } from "./builtin-import-plugin.js";

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Owns installed backend plugins and routes server-side contributions. */
export class BackendPluginHost {
  readonly #imports: ImportProviderRegistry;
  readonly #installed = new Set<string>();

  constructor(imports: ImportProviderRegistry) {
    this.#imports = imports;
  }

  /** Installs one backend-only plugin before services accept requests. */
  install(plugin: BackendPlugin): void {
    validateBackendManifest(plugin);
    if (this.#installed.has(plugin.manifest.id)) {
      throw new Error(
        `Backend plugin is already installed: ${plugin.manifest.id}`,
      );
    }
    plugin.register({
      register: (provider, contribution) =>
        this.#register(provider, contribution),
    });
    this.#installed.add(plugin.manifest.id);
  }

  /** Reports whether one stable plugin ID completed registration. */
  has(pluginId: string): boolean {
    return this.#installed.has(pluginId);
  }

  /** Routes a type-checked contribution to its backend-owned registry. */
  #register<TProvider extends keyof BackendPluginProviders>(
    provider: TProvider,
    contribution: BackendPluginProviders[TProvider],
  ): void {
    if (provider === "request.import") {
      this.#imports.register(contribution as ImportProvider);
      return;
    }
    throw new Error(`Unsupported backend plugin provider: ${String(provider)}`);
  }
}

/** Groups an initialized backend host with its service-facing registries. */
export interface BackendPluginRuntime {
  readonly plugins: BackendPluginHost;
  readonly imports: ImportProviderRegistry;
}

/** Creates an isolated backend plugin runtime for composition or tests. */
export function createBackendPluginRuntime(
  plugins: readonly BackendPlugin[] = [builtinImportPlugin],
): BackendPluginRuntime {
  const imports = new ImportProviderRegistry();
  const host = new BackendPluginHost(imports);
  for (const plugin of plugins) host.install(plugin);
  return { plugins: host, imports };
}

/** Rejects malformed or cross-runtime plugin packages before registration. */
function validateBackendManifest(plugin: BackendPlugin): void {
  const { manifest } = plugin;
  if (manifest.apiVersion !== 1) {
    throw new Error(
      `Unsupported backend plugin API version: ${String(manifest.apiVersion)}`,
    );
  }
  if (manifest.target !== "backend") {
    throw new Error(
      `Backend host cannot install a ${String(manifest.target)} plugin`,
    );
  }
  if (!pluginIdPattern.test(manifest.id)) {
    throw new Error(`Invalid backend plugin ID: ${manifest.id}`);
  }
  if (manifest.name.trim() === "") {
    throw new Error(`Backend plugin name is required: ${manifest.id}`);
  }
  if (!semanticVersionPattern.test(manifest.version)) {
    throw new Error(`Invalid backend plugin version: ${manifest.version}`);
  }
}

export const backendPluginRuntime = createBackendPluginRuntime();
