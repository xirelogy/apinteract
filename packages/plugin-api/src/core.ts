export type PluginTarget = "frontend" | "backend";

export type PluginPackageTarget = PluginTarget | "auth-provider";

export type PluginSource = "built-in" | "user";

/** Current JSON manifest format generation accepted by plugin hosts. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;

/** Manifest generation used by matched authentication-provider bundles. */
export const AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION = 2;

/** Current executable host/plugin compatibility generation. */
export const PLUGIN_API_VERSION = 1;

/** Fields shared by every installable plugin package generation. */
interface PluginPackageManifestBase {
  /** Selects the JSON manifest format independently of the executable API. */
  /** Selects one breaking-compatibility generation of the host/plugin API. */
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Higher weights are presented before lower-weight plugin contributions. */
  readonly weight?: number;
}

/** Identifies one schema-v1 package with a single execution target. */
export interface SingleTargetPluginPackageManifest<
  TTarget extends PluginTarget = PluginTarget,
> extends PluginPackageManifestBase {
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly target: TTarget;
  readonly entrypoint: string;
  readonly providers: readonly string[];
}

/** Identifies one built-in auth package with an atomic runtime pair. */
export interface AuthProviderPluginPackageManifest
  extends PluginPackageManifestBase {
  readonly schemaVersion: typeof AUTH_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly target: "auth-provider";
  readonly entrypoints: {
    readonly backend: string;
    readonly frontend: string;
  };
  readonly providers: {
    readonly backend: readonly ["authentication.provider"];
    readonly frontend: readonly ["authentication.login"];
  };
}

/** Selects the manifest shape accepted for a requested package target. */
export type PluginPackageManifest<
  TTarget extends PluginPackageTarget = PluginPackageTarget,
> = TTarget extends "auth-provider"
  ? AuthProviderPluginPackageManifest
  : TTarget extends PluginTarget
    ? SingleTargetPluginPackageManifest<TTarget>
    : SingleTargetPluginPackageManifest | AuthProviderPluginPackageManifest;

/** Describes one successfully loaded plugin without exposing contributions. */
export interface EnabledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly target: PluginPackageTarget;
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
