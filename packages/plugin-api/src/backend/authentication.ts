import type { APInteractPluginModule } from "../core.js";

/** JSON-compatible values accepted at the plugin trust boundary. */
export type AuthProviderValue =
  | null
  | boolean
  | number
  | string
  | readonly AuthProviderValue[]
  | { readonly [key: string]: AuthProviderValue };

/** Bounded JSON Schema subset used for startup configuration validation. */
export type AuthProviderConfigurationSchema =
  | {
      readonly type: "object";
      readonly properties?: Readonly<
        Record<string, AuthProviderConfigurationSchema>
      >;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    }
  | {
      readonly type: "array";
      readonly items: AuthProviderConfigurationSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: "string";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly secret?: boolean;
    }
  | {
      readonly type: "number";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "boolean" };

/** Publicly safe presentation data derived by one configured backend instance. */
export interface AuthProviderPublicConfiguration {
  readonly [key: string]: AuthProviderValue;
}

/** Identifies a configured provider instance without exposing private settings. */
export interface AuthProviderPublicDescriptor {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly description?: string;
  readonly availability: "available" | "unavailable";
  readonly publicConfiguration: AuthProviderPublicConfiguration;
}

/** Carries bounded provider-specific evidence for one authentication transition. */
export interface AuthProviderInput {
  readonly [field: string]: string;
}

/** Represents provider-owned state retained only within an authentication attempt. */
export interface AuthProviderAttemptState {
  readonly schemaVersion: number;
  readonly data: AuthProviderValue;
}

/** Proves one stable provider-scoped subject without choosing an application user. */
export interface AuthProviderAssertion {
  readonly providerInstanceId: string;
  readonly subject: string;
  readonly authenticatedAt: number;
  readonly authenticationMethods: readonly string[];
  readonly safeProfileClaims?: Readonly<Record<string, string>>;
}

/** Describes one provider transition without exposing session credentials. */
export type AuthProviderFlowResult =
  | {
      readonly status: "interaction_required";
      readonly state: AuthProviderAttemptState;
      readonly publicData: AuthProviderValue;
    }
  | {
      readonly status: "authenticated";
      readonly assertion: AuthProviderAssertion;
    }
  | { readonly status: "rejected"; readonly internalCode: string }
  | {
      readonly status: "unavailable";
      readonly internalCode: string;
      readonly retryable: boolean;
    };

/** Stores one provider-defined, versioned multi-field credential value. */
export interface AuthProviderCredentialMaterial {
  readonly schemaVersion: number;
  readonly data: AuthProviderValue;
}

/** Defines one provider-owned identifier usable for credential lookup. */
export interface AuthProviderCredentialLookupKey {
  readonly key: string;
  readonly value: string;
}

/** Returns material and stable identity for one active provider credential. */
export interface AuthProviderStoredCredential {
  readonly subject: string;
  readonly material: AuthProviderCredentialMaterial;
}

/** Provides read-only access scoped to the configured provider instance. */
export interface AuthProviderCredentialReader {
  findByLookupKey(
    key: string,
    normalizedValue: string,
  ): Promise<AuthProviderStoredCredential | null>;
}

/** Supplies narrow host mechanisms without exposing persistence or sessions. */
export interface AuthProviderBackendServices {
  readonly clock: { now(): number };
  readonly secureRandom: { bytes(length: number): Uint8Array };
  readonly passwords: {
    hash(password: string): Promise<string>;
    verify(password: string, encodedHash: string): Promise<boolean>;
  };
  readonly credentials: AuthProviderCredentialReader;
}

/** Produces provider-owned material used by optional administrative practices. */
export interface AuthProviderCredentialCreation {
  readonly subject: string;
  readonly lookupKeys: readonly AuthProviderCredentialLookupKey[];
  readonly material: AuthProviderCredentialMaterial;
}

/** Optional credential practices supported by a configured provider. */
export interface AuthProviderCredentialManager {
  create(input: AuthProviderInput): Promise<AuthProviderCredentialCreation>;
  update(
    current: AuthProviderStoredCredential,
    input: AuthProviderInput,
  ): Promise<AuthProviderCredentialCreation>;
}

/** Executes one configured provider instance. */
export interface AuthProviderBackendInstance {
  publicConfiguration(): AuthProviderPublicConfiguration;
  begin(input: AuthProviderInput): Promise<AuthProviderFlowResult>;
  continue?(
    state: AuthProviderAttemptState,
    input: AuthProviderInput,
  ): Promise<AuthProviderFlowResult>;
  cancel?(state: AuthProviderAttemptState): void | Promise<void>;
  health?(): "available" | "unavailable" | Promise<"available" | "unavailable">;
  readonly credentials?: AuthProviderCredentialManager;
  dispose?(): void | Promise<void>;
}

/** Defines one backend provider type that can create configured instances. */
export interface AuthProviderBackendContribution {
  readonly configurationSchema: AuthProviderConfigurationSchema;
  createInstance(
    instanceId: string,
    configuration: AuthProviderValue,
    services: AuthProviderBackendServices,
  ): AuthProviderBackendInstance | Promise<AuthProviderBackendInstance>;
}

/** Lists the sole capability accepted from an auth bundle backend entrypoint. */
export interface AuthProviderBackendPluginProviders {
  readonly "authentication.provider": AuthProviderBackendContribution;
}

export type AuthProviderBackendPluginModule =
  APInteractPluginModule<AuthProviderBackendPluginProviders>;
