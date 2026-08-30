export type PluginTarget = "frontend" | "backend";

export type PluginSource = "built-in" | "user";

/** Identifies one installable plugin package and its single execution target. */
export interface PluginPackageManifest<
  TTarget extends PluginTarget = PluginTarget,
> {
  readonly schemaVersion: 1;
  readonly apiVersion: 2;
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
