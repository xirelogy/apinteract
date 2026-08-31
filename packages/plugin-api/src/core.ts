export type PluginTarget = "frontend" | "backend";

export type PluginSource = "built-in" | "user";

/** Current JSON manifest format generation accepted by plugin hosts. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;

/** Current executable host/plugin compatibility generation. */
export const PLUGIN_API_VERSION = 1;

/** Identifies one installable plugin package and its single execution target. */
export interface PluginPackageManifest<
  TTarget extends PluginTarget = PluginTarget,
> {
  /** Selects the JSON manifest format independently of the executable API. */
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  /** Selects one breaking-compatibility generation of the host/plugin API. */
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Higher weights are presented before lower-weight plugin contributions. */
  readonly weight?: number;
  readonly target: TTarget;
  readonly entrypoint: string;
  readonly providers: readonly string[];
}

/** Describes one successfully loaded plugin without exposing contributions. */
export interface EnabledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly target: PluginTarget;
  readonly source: PluginSource;
}

/** Exposes only the typed extension providers owned by one plugin host. */
export interface PluginRegistrationContext<TProviders extends object> {
  register<TProvider extends Extract<keyof TProviders, string>>(
    provider: TProvider,
    contribution: TProviders[TProvider],
  ): void;
}

/** Defines the common package signature shared by single-target plugins. */
export interface APInteractPluginModule<TProviders extends object> {
  register(context: PluginRegistrationContext<TProviders>): void;
}
