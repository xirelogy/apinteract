import {
  AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
} from "@apinteract/plugin-api";
import type {
  AuthProviderFrontendContribution,
  AuthProviderFrontendHandle,
  AuthProviderFrontendPluginModule,
} from "@apinteract/plugin-api/frontend/authentication";

import type { SessionController } from "@/control/session/session-controller";
import type { AuthProviderCatalogEntry } from "@/control/transport/http-client";

/** Owns validated built-in authentication contributions before login. */
class AuthProviderFrontendHost {
  readonly #catalog: AuthProviderCatalogEntry[] = [];
  readonly #contributions = new Map<string, AuthProviderFrontendContribution>();

  /** Loads only backend-selected, content-addressed auth bundle frontends. */
  async load(entries: readonly AuthProviderCatalogEntry[]): Promise<void> {
    this.#catalog.length = 0;
    this.#contributions.clear();
    const instanceIds = new Set<string>();
    for (const entry of entries) {
      validateEntry(entry);
      if (instanceIds.has(entry.descriptor.id)) {
        throw new Error(
          `Authentication provider instance is duplicated: ${entry.descriptor.id}`,
        );
      }
      instanceIds.add(entry.descriptor.id);
      const imported = (await import(
        /* @vite-ignore */ entry.moduleUrl
      )) as Record<string, unknown>;
      if (typeof imported.register !== "function") {
        throw new Error(
          `Authentication plugin ${entry.manifest.id} does not export register`,
        );
      }
      const contributions: AuthProviderFrontendContribution[] = [];
      const module: AuthProviderFrontendPluginModule = {
        register:
          imported.register as AuthProviderFrontendPluginModule["register"],
      };
      module.register({
        /** Captures the plugin's single declared login contribution. */
        register(provider, contribution) {
          if (provider !== "authentication.login") {
            throw new Error(
              `Unsupported authentication frontend provider: ${String(provider)}`,
            );
          }
          contributions.push(contribution);
        },
      });
      if (contributions.length !== 1) {
        throw new Error(
          `Authentication plugin ${entry.manifest.id} must register exactly one login contribution`,
        );
      }
      this.#contributions.set(entry.manifest.id, contributions[0]!);
      this.#catalog.push(entry);
    }
  }

  /** Lists configured provider instances in backend configuration order. */
  entries(): readonly AuthProviderCatalogEntry[] {
    return this.#catalog;
  }

  /** Mounts one selected instance with only narrow host authentication actions. */
  mount(
    container: HTMLElement,
    instanceId: string,
    locale: string,
    session: SessionController,
    completed: () => void,
  ): AuthProviderFrontendHandle {
    const entry = this.#catalog.find(
      (candidate) => candidate.descriptor.id === instanceId,
    );
    if (entry === undefined) {
      throw new Error(
        `Authentication provider instance is unavailable: ${instanceId}`,
      );
    }
    const contribution = this.#contributions.get(entry.manifest.id);
    if (contribution === undefined) {
      throw new Error(
        `Authentication frontend is unavailable: ${entry.manifest.id}`,
      );
    }
    return contribution.mount(container, {
      instance: entry.descriptor,
      locale,
      actions: {
        begin: (input) => session.beginAuthentication(instanceId, input),
        continue: (input) => session.continueAuthentication(input),
        cancel: () => session.cancelAuthentication(),
        completed,
      },
    });
  }
}

/** Validates the anonymous catalog before importing executable code. */
function validateEntry(entry: AuthProviderCatalogEntry): void {
  const value: unknown = entry;
  if (!isRecord(value)) {
    throw new Error("Authentication provider catalog entry is invalid");
  }
  const manifestValue = value.manifest;
  const descriptorValue = value.descriptor;
  if (
    !isRecord(manifestValue) ||
    !isRecord(manifestValue.entrypoints) ||
    !isRecord(manifestValue.providers) ||
    !Array.isArray(manifestValue.providers.backend) ||
    !Array.isArray(manifestValue.providers.frontend) ||
    !isRecord(descriptorValue) ||
    typeof value.moduleUrl !== "string"
  ) {
    throw new Error("Authentication provider catalog entry is invalid");
  }
  const manifest = manifestValue;
  const descriptor = descriptorValue;
  const entrypoints = manifestValue.entrypoints;
  const backendProviders = manifestValue.providers.backend as unknown[];
  const frontendProviders = manifestValue.providers.frontend as unknown[];
  if (
    manifest.schemaVersion !== AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION ||
    manifest.apiVersion !== PLUGIN_API_VERSION ||
    manifest.target !== "auth-provider" ||
    typeof manifest.id !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(manifest.id) ||
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    typeof manifest.version !== "string" ||
    backendProviders.length !== 1 ||
    backendProviders[0] !== "authentication.provider" ||
    frontendProviders.length !== 1 ||
    frontendProviders[0] !== "authentication.login" ||
    typeof descriptor.pluginId !== "string" ||
    descriptor.pluginId !== manifest.id ||
    typeof descriptor.id !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(descriptor.id) ||
    descriptor.id.length > 128 ||
    typeof descriptor.label !== "string" ||
    descriptor.label.length === 0 ||
    descriptor.label.length > 200 ||
    (descriptor.description !== undefined &&
      (typeof descriptor.description !== "string" ||
        descriptor.description.length === 0 ||
        descriptor.description.length > 1000)) ||
    (descriptor.availability !== "available" &&
      descriptor.availability !== "unavailable") ||
    !isRecord(descriptor.publicConfiguration) ||
    !isAuthModuleUrl(
      value.moduleUrl,
      manifest.id,
      typeof entrypoints.frontend === "string" ? entrypoints.frontend : "",
    )
  ) {
    throw new Error("Authentication provider catalog entry is invalid");
  }
}

/** Accepts only same-origin immutable module paths under the auth boundary. */
function isAuthModuleUrl(
  value: string,
  pluginId: string,
  frontendEntrypoint: string,
): boolean {
  const segments = value.split("/");
  const assetPath = segments.slice(5).join("/");
  return (
    segments.length >= 6 &&
    segments[0] === "" &&
    segments[1] === "auth" &&
    segments[2] === "plugins" &&
    segments[3] === pluginId &&
    /^[a-f0-9]{64}$/u.test(segments[4] ?? "") &&
    frontendEntrypoint.startsWith("dist/") &&
    assetPath === frontendEntrypoint.slice("dist/".length) &&
    segments
      .slice(5)
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9._-]+$/u.test(segment),
      ) &&
    /\.(?:js|mjs)$/u.test(segments.at(-1) ?? "")
  );
}

/** Narrows anonymous catalog data to a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const authProviderFrontendHost = new AuthProviderFrontendHost();
