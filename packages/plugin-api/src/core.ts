export type PluginTarget = "frontend" | "backend";

/** Identifies one installable plugin package and its single execution target. */
export interface PluginManifest<TTarget extends PluginTarget = PluginTarget> {
  readonly apiVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly target: TTarget;
}

/** Exposes only the typed extension providers owned by one plugin host. */
export interface PluginRegistrationContext<TProviders extends object> {
  register<TProvider extends Extract<keyof TProviders, string>>(
    provider: TProvider,
    contribution: TProviders[TProvider],
  ): void;
}

/** Defines the common package signature shared by single-target plugins. */
export interface APInteractPlugin<
  TTarget extends PluginTarget,
  TProviders extends object,
> {
  readonly manifest: PluginManifest<TTarget>;
  register(context: PluginRegistrationContext<TProviders>): void;
}
