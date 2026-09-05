import type {
  AuthProviderPluginPackageManifest,
  PluginSource,
} from "@apinteract/plugin-api";
import type {
  AuthProviderBackendContribution,
  AuthProviderBackendInstance,
  AuthProviderBackendPluginModule,
  AuthProviderBackendServices,
  AuthProviderPublicDescriptor,
} from "@apinteract/plugin-api/backend/authentication";

import type { AuthenticationProviderConfiguration } from "../config.js";
import { validateAuthProviderConfiguration } from "./configuration-schema.js";
import { validateProviderObject } from "./provider-value.js";

interface InstalledAuthProviderPlugin {
  readonly manifest: AuthProviderPluginPackageManifest;
  readonly contribution: AuthProviderBackendContribution;
}

export class AuthProviderNotConfiguredError extends Error {}

/** Connects one configured provider envelope to its initialized runtime. */
export interface ConfiguredAuthProvider {
  readonly configuration: AuthenticationProviderConfiguration;
  readonly manifest: AuthProviderPluginPackageManifest;
  readonly runtime: AuthProviderBackendInstance;
}

/** Owns startup-critical auth bundle registration and configured instances. */
export class AuthProviderRegistry {
  readonly #plugins = new Map<string, InstalledAuthProviderPlugin>();
  readonly #instances = new Map<string, ConfiguredAuthProvider>();

  /** Installs exactly one declared backend contribution from a built-in bundle. */
  install(
    manifest: AuthProviderPluginPackageManifest,
    module: AuthProviderBackendPluginModule,
    source: PluginSource,
  ): void {
    if (source !== "built-in") {
      throw new Error("Authentication provider bundles must be built in");
    }
    if (this.#plugins.has(manifest.id)) {
      throw new Error(
        `Authentication provider plugin is already installed: ${manifest.id}`,
      );
    }
    const contributions: AuthProviderBackendContribution[] = [];
    module.register({
      /** Captures the plugin's single declared authentication contribution. */
      register(provider, contribution) {
        if (provider !== "authentication.provider") {
          throw new Error(
            `Unsupported authentication provider: ${String(provider)}`,
          );
        }
        contributions.push(contribution);
      },
    });
    if (contributions.length !== 1) {
      throw new Error(
        `Authentication provider plugin ${manifest.id} must register exactly one contribution`,
      );
    }
    const contribution = contributions[0];
    if (
      !isRecord(contribution) ||
      !isRecord(contribution.configurationSchema) ||
      typeof contribution.createInstance !== "function"
    ) {
      throw new Error(
        `Authentication plugin ${manifest.id} returned an invalid contribution`,
      );
    }
    this.#plugins.set(manifest.id, {
      manifest,
      contribution,
    });
  }

  /** Validates and initializes every configured provider in presentation order. */
  async initialize(
    configurations: readonly AuthenticationProviderConfiguration[],
    services: (instanceId: string) => AuthProviderBackendServices,
  ): Promise<void> {
    if (this.#instances.size !== 0) {
      throw new Error("Authentication providers are already initialized");
    }
    try {
      for (const configuration of configurations) {
        const plugin = this.#plugins.get(configuration.plugin);
        if (plugin === undefined) {
          throw new Error(
            `Configured authentication provider ${configuration.id} selects an unavailable built-in plugin`,
          );
        }
        try {
          validateAuthProviderConfiguration(
            plugin.contribution.configurationSchema,
            configuration.configuration,
            `authentication provider ${configuration.id} configuration`,
          );
          const runtime = await plugin.contribution.createInstance(
            configuration.id,
            configuration.configuration,
            services(configuration.id),
          );
          validateRuntime(runtime);
          this.#instances.set(configuration.id, {
            configuration,
            manifest: plugin.manifest,
            runtime,
          });
        } catch (cause) {
          throw new Error(
            `Authentication provider ${configuration.id} could not be initialized`,
            { cause },
          );
        }
      }
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  /** Returns one configured runtime or rejects an unconfigured switching key. */
  require(instanceId: string): ConfiguredAuthProvider {
    const provider = this.#instances.get(instanceId);
    if (provider === undefined) {
      throw new AuthProviderNotConfiguredError(
        `Authentication provider instance is not configured: ${instanceId}`,
      );
    }
    return provider;
  }

  /** Lists safe configured descriptors in administrator-defined order. */
  async descriptors(): Promise<readonly AuthProviderPublicDescriptor[]> {
    return Promise.all(
      [...this.#instances.values()].map(async (provider) => {
        const health = (await provider.runtime.health?.()) ?? "available";
        if (health !== "available" && health !== "unavailable") {
          throw new Error(
            `Authentication provider ${provider.configuration.id} returned invalid health`,
          );
        }
        const publicConfiguration = provider.runtime.publicConfiguration();
        validatePublicConfiguration(publicConfiguration);
        return {
          id: provider.configuration.id,
          pluginId: provider.manifest.id,
          label: provider.configuration.label,
          ...(provider.configuration.description === undefined
            ? {}
            : { description: provider.configuration.description }),
          availability: health,
          publicConfiguration,
        };
      }),
    );
  }

  /** Disposes initialized providers in reverse configuration order. */
  async close(): Promise<void> {
    const providers = [...this.#instances.values()].reverse();
    this.#instances.clear();
    await Promise.all(
      providers.map((provider) =>
        Promise.resolve(provider.runtime.dispose?.()),
      ),
    );
  }
}

/** Requires a complete runtime shape before making an instance selectable. */
function validateRuntime(value: AuthProviderBackendInstance): void {
  if (
    !isRecord(value) ||
    typeof value.publicConfiguration !== "function" ||
    typeof value.begin !== "function" ||
    (value.continue !== undefined && typeof value.continue !== "function") ||
    (value.cancel !== undefined && typeof value.cancel !== "function") ||
    (value.health !== undefined && typeof value.health !== "function") ||
    (value.dispose !== undefined && typeof value.dispose !== "function") ||
    (value.credentials !== undefined &&
      (!isRecord(value.credentials) ||
        typeof value.credentials.create !== "function" ||
        typeof value.credentials.update !== "function"))
  ) {
    throw new Error("Authentication provider returned an invalid runtime");
  }
}

/** Prevents malformed or oversized provider data from entering the public catalog. */
function validatePublicConfiguration(
  value: ReturnType<AuthProviderBackendInstance["publicConfiguration"]>,
): void {
  validateProviderObject(value, "Authentication provider public configuration");
}

/** Narrows plugin-owned runtime values to non-array objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
