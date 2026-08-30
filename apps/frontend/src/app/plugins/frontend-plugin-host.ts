import type {
  EnabledPlugin,
  PluginPackageManifest,
  PluginSource,
} from "@apinteract/plugin-api";
import type {
  FrontendPluginModule,
  FrontendPluginProviders,
  RequestBodyDefinition,
  RequestContentContribution,
  ResponseContentContribution,
} from "@apinteract/plugin-api/frontend";

import { RequestBodyPresetRegistry } from "@/model/domain/request-body-presets";
import { ResponseContentPresenterRegistry } from "@/model/domain/response-content";

const requiredBodies: readonly RequestBodyDefinition[] = [
  { kind: "none" },
  { kind: "text", contentType: "text/plain", text: "" },
  { kind: "urlencoded", contentType: null, fields: [] },
  { kind: "multipart", contentType: null, boundary: "test", fields: [] },
  {
    kind: "file",
    contentType: null,
    attachment: {
      attachmentId: "00000000-0000-7000-8000-000000000000",
      workspaceId: "00000000-0000-7000-8000-000000000000",
      fileName: "test.bin",
      contentType: "application/octet-stream",
      byteLength: 0,
      sha256: "0".repeat(64),
    },
  },
];

/** Owns installed frontend plugins and commits each registration atomically. */
export class FrontendPluginHost {
  readonly #installed = new Map<string, EnabledPlugin>();
  readonly #requestContent: RequestBodyPresetRegistry;
  readonly #responseContent: ResponseContentPresenterRegistry;

  constructor(
    requestContent: RequestBodyPresetRegistry,
    responseContent: ResponseContentPresenterRegistry,
  ) {
    this.#requestContent = requestContent;
    this.#responseContent = responseContent;
  }

  /** Installs one validated frontend package without exposing partial work. */
  install(
    manifest: PluginPackageManifest<"frontend">,
    plugin: FrontendPluginModule,
    source: PluginSource,
  ): void {
    if (this.#installed.has(manifest.id)) {
      throw new Error(`Frontend plugin is already installed: ${manifest.id}`);
    }
    const contributions: FrontendContribution[] = [];
    plugin.register({
      register: (provider, contribution) => {
        if (!manifest.providers.includes(provider)) {
          throw new Error(
            `Frontend plugin ${manifest.id} did not declare provider ${provider}`,
          );
        }
        contributions.push({ provider, contribution } as FrontendContribution);
      },
    });
    validateDeclaredProviders(manifest, contributions);
    this.#validateAtomicRegistration(manifest.id, contributions);
    for (const contribution of contributions) {
      this.#register(manifest.id, contribution, manifest.weight ?? 0);
    }
    this.#installed.set(manifest.id, enabledPlugin(manifest, source));
  }

  /** Returns successfully installed frontend packages in installation order. */
  list(): readonly EnabledPlugin[] {
    return [...this.#installed.values()];
  }

  /** Reports whether one stable plugin ID completed registration. */
  has(pluginId: string): boolean {
    return this.#installed.has(pluginId);
  }

  /** Verifies the host primitives required by every request-body wire kind. */
  validateCapabilities(): void {
    for (const body of requiredBodies) {
      this.#requestContent.resolveBody(body);
    }
  }

  /** Validates all contributions against cloned registries before committing. */
  #validateAtomicRegistration(
    pluginId: string,
    contributions: readonly FrontendContribution[],
  ): void {
    const requestContent = new RequestBodyPresetRegistry();
    const responseContent = new ResponseContentPresenterRegistry();
    for (const contribution of this.#requestContent.list()) {
      const [ownerId, localId] = contributionIdParts(contribution.id);
      requestContent.register({ ...contribution, id: localId }, ownerId);
    }
    for (const contribution of this.#responseContent.list()) {
      const [ownerId] = contribution.id.split("/", 1);
      responseContent.register(
        { ...contribution, id: contribution.id.slice(ownerId!.length + 1) },
        ownerId,
      );
    }
    for (const contribution of contributions) {
      registerFrontendContribution(
        pluginId,
        contribution,
        requestContent,
        responseContent,
        0,
      );
    }
  }

  /** Routes one committed contribution to its host-owned registry. */
  #register(
    pluginId: string,
    contribution: FrontendContribution,
    pluginWeight: number,
  ): void {
    registerFrontendContribution(
      pluginId,
      contribution,
      this.#requestContent,
      this.#responseContent,
      pluginWeight,
    );
  }
}

/** Splits one host-qualified contribution ID back into package and local parts. */
function contributionIdParts(id: string): readonly [string, string] {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`Contribution ID is not host-qualified: ${id}`);
  }
  return [id.slice(0, separator), id.slice(separator + 1)];
}

type FrontendContribution =
  | {
      readonly provider: "request.content";
      readonly contribution: RequestContentContribution;
    }
  | {
      readonly provider: "response.content";
      readonly contribution: ResponseContentContribution;
    };

/** Groups the initialized frontend host with registries consumed by views. */
export interface FrontendPluginRuntime {
  readonly plugins: FrontendPluginHost;
  readonly requestContent: RequestBodyPresetRegistry;
  readonly responseContent: ResponseContentPresenterRegistry;
}

/** Creates an empty frontend runtime populated only through package loading. */
export function createFrontendPluginRuntime(): FrontendPluginRuntime {
  const requestContent = new RequestBodyPresetRegistry();
  const responseContent = new ResponseContentPresenterRegistry();
  const plugins = new FrontendPluginHost(requestContent, responseContent);
  return { plugins, requestContent, responseContent };
}

/** Commits one narrowed contribution to the matching host registry. */
function registerFrontendContribution(
  pluginId: string,
  registered: FrontendContribution,
  requestContent: RequestBodyPresetRegistry,
  responseContent: ResponseContentPresenterRegistry,
  pluginWeight = 0,
): void {
  if (registered.provider === "request.content") {
    requestContent.register(registered.contribution, pluginId, pluginWeight);
    return;
  }
  responseContent.register(registered.contribution, pluginId);
}

/** Requires every declared provider to receive at least one contribution. */
function validateDeclaredProviders(
  manifest: PluginPackageManifest<"frontend">,
  contributions: readonly FrontendContribution[],
): void {
  for (const provider of manifest.providers) {
    if (!Object.hasOwn(frontendProviderNames, provider)) {
      throw new Error(`Unsupported frontend plugin provider: ${provider}`);
    }
    if (
      !contributions.some((contribution) => contribution.provider === provider)
    ) {
      throw new Error(
        `Frontend plugin ${manifest.id} registered no ${provider} contribution`,
      );
    }
  }
}

const frontendProviderNames: Readonly<
  Record<keyof FrontendPluginProviders, true>
> = { "request.content": true, "response.content": true };

/** Converts canonical package metadata into the read-only enabled view. */
function enabledPlugin(
  manifest: PluginPackageManifest<"frontend">,
  source: PluginSource,
): EnabledPlugin {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    target: manifest.target,
    source,
  };
}

export const frontendPluginRuntime = createFrontendPluginRuntime();
