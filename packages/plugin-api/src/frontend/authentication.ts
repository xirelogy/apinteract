import type { APInteractPluginModule } from "../core.js";
import type {
  AuthProviderInput,
  AuthProviderPublicDescriptor,
  AuthProviderValue,
} from "../backend/authentication.js";

/** Result visible to provider UI after core processes one authentication action. */
export type AuthProviderFrontendResult =
  | {
      readonly status: "interaction_required";
      readonly publicData: AuthProviderValue;
    }
  | { readonly status: "authenticated" }
  | { readonly status: "rejected" }
  | { readonly status: "unavailable"; readonly retryable: boolean };

/** Narrow host operations available to provider-owned login presentation. */
export interface AuthProviderFrontendActions {
  begin(input: AuthProviderInput): Promise<AuthProviderFrontendResult>;
  continue(input: AuthProviderInput): Promise<AuthProviderFrontendResult>;
  cancel(): Promise<void>;
  completed(): void;
}

/** Context supplied while one configured provider instance is selected. */
export interface AuthProviderFrontendContext {
  readonly instance: AuthProviderPublicDescriptor;
  readonly locale: string;
  readonly actions: AuthProviderFrontendActions;
}

/** Disposes one mounted provider login experience. */
export interface AuthProviderFrontendHandle {
  destroy(): void;
}

/** Owns one provider-specific login experience in a host container. */
export interface AuthProviderFrontendContribution {
  mount(
    container: HTMLElement,
    context: AuthProviderFrontendContext,
  ): AuthProviderFrontendHandle;
}

/** Lists the sole capability accepted from an auth bundle frontend entrypoint. */
export interface AuthProviderFrontendPluginProviders {
  readonly "authentication.login": AuthProviderFrontendContribution;
}

export type AuthProviderFrontendPluginModule =
  APInteractPluginModule<AuthProviderFrontendPluginProviders>;
