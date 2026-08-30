import type {
  FrontendPlugin,
  FrontendPluginProviders,
  RequestContentContribution,
  ResponseContentContribution,
} from "@apinteract/plugin-api/frontend";

import { builtinContentPlugin } from "@/app/plugins/builtin-content-plugin";
import { RequestBodyPresetRegistry } from "@/model/domain/request-body-presets";
import { ResponseContentPresenterRegistry } from "@/model/domain/response-content";

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Owns installed frontend plugins and routes their typed contributions. */
export class FrontendPluginHost {
  readonly #installed = new Set<string>();
  readonly #requestContent: RequestBodyPresetRegistry;
  readonly #responseContent: ResponseContentPresenterRegistry;

  constructor(
    requestContent: RequestBodyPresetRegistry,
    responseContent: ResponseContentPresenterRegistry,
  ) {
    this.#requestContent = requestContent;
    this.#responseContent = responseContent;
  }

  /** Installs one frontend-only plugin during application bootstrap. */
  install(plugin: FrontendPlugin): void {
    validateFrontendManifest(plugin);
    if (this.#installed.has(plugin.manifest.id)) {
      throw new Error(
        `Frontend plugin is already installed: ${plugin.manifest.id}`,
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

  /** Routes a type-checked contribution to its runtime-specific registry. */
  #register<TProvider extends keyof FrontendPluginProviders>(
    provider: TProvider,
    contribution: FrontendPluginProviders[TProvider],
  ): void {
    if (provider === "request.content") {
      this.#requestContent.register(contribution as RequestContentContribution);
      return;
    }
    if (provider === "response.content") {
      this.#responseContent.register(
        contribution as ResponseContentContribution,
      );
      return;
    }
    throw new Error(
      `Unsupported frontend plugin provider: ${String(provider)}`,
    );
  }
}

/** Groups the initialized frontend host with the registries consumed by views. */
export interface FrontendPluginRuntime {
  readonly plugins: FrontendPluginHost;
  readonly requestContent: RequestBodyPresetRegistry;
  readonly responseContent: ResponseContentPresenterRegistry;
}

/** Creates an isolated frontend plugin runtime for bootstrap or tests. */
export function createFrontendPluginRuntime(
  plugins: readonly FrontendPlugin[] = [builtinContentPlugin],
): FrontendPluginRuntime {
  const requestContent = new RequestBodyPresetRegistry();
  const responseContent = new ResponseContentPresenterRegistry();
  const host = new FrontendPluginHost(requestContent, responseContent);
  for (const plugin of plugins) host.install(plugin);
  return { plugins: host, requestContent, responseContent };
}

/** Rejects malformed or cross-runtime plugin packages before registration. */
function validateFrontendManifest(plugin: FrontendPlugin): void {
  const { manifest } = plugin;
  if (manifest.apiVersion !== 1) {
    throw new Error(
      `Unsupported frontend plugin API version: ${String(manifest.apiVersion)}`,
    );
  }
  if (manifest.target !== "frontend") {
    throw new Error(
      `Frontend host cannot install a ${String(manifest.target)} plugin`,
    );
  }
  if (!pluginIdPattern.test(manifest.id)) {
    throw new Error(`Invalid frontend plugin ID: ${manifest.id}`);
  }
  if (manifest.name.trim() === "") {
    throw new Error(`Frontend plugin name is required: ${manifest.id}`);
  }
  if (!semanticVersionPattern.test(manifest.version)) {
    throw new Error(`Invalid frontend plugin version: ${manifest.version}`);
  }
}

export const frontendPluginRuntime = createFrontendPluginRuntime();
