import type { AuthProviderPublicDescriptor } from "@apinteract/plugin-api/backend/authentication";

import {
  InstanceAlreadyInitializedError,
  type ApplicationUser,
  type IdentityService,
} from "../identity/identity-service.js";
import type { AuthProviderRegistry } from "./auth-provider-registry.js";

const LOCAL_PASSWORD_PLUGIN_ID = "builtin.local-password";
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 10;

/** One configured local-password instance eligible for first-user setup. */
export interface WebBootstrapProvider {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** Public first-user state that never includes credential or provider material. */
export interface WebBootstrapStatus {
  readonly available: boolean;
  readonly providers: readonly WebBootstrapProvider[];
}

export class WebBootstrapUnavailableError extends Error {}
export class WebBootstrapInputError extends Error {}
export class WebBootstrapRateLimitError extends Error {}

/** Coordinates optional one-time web initialization through local password. */
export class FirstUserBootstrapService {
  readonly #enabled: boolean;
  readonly #providers: AuthProviderRegistry;
  readonly #identity: IdentityService;
  readonly #rateLimits = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    enabled: boolean,
    providers: AuthProviderRegistry,
    identity: IdentityService,
  ) {
    this.#enabled = enabled;
    this.#providers = providers;
    this.#identity = identity;
  }

  /** Reports eligible local-password instances while the database is fresh. */
  async status(): Promise<WebBootstrapStatus> {
    if (!this.#enabled || (await this.#identity.isInitialized())) {
      return { available: false, providers: [] };
    }
    const providers = (await this.#providers.descriptors())
      .filter(isAvailableLocalPassword)
      .map(({ id, label, description }) => ({
        id,
        label,
        ...(description === undefined ? {} : { description }),
      }));
    return { available: providers.length !== 0, providers };
  }

  /** Creates the only first administrator after rechecking persisted state. */
  async initialize(
    providerInstanceId: string,
    username: string,
    displayName: string,
    password: string,
    rateLimitKey: string,
  ): Promise<ApplicationUser> {
    validateInput(providerInstanceId, username, displayName, password);
    if (!this.#enabled) {
      throw new WebBootstrapUnavailableError("Web bootstrap is disabled");
    }
    if (await this.#identity.isInitialized()) {
      throw new InstanceAlreadyInitializedError(
        "The APInteract instance is already initialized",
      );
    }
    const provider = (await this.#providers.descriptors()).find(
      (candidate) => candidate.id === providerInstanceId,
    );
    if (provider === undefined || !isAvailableLocalPassword(provider)) {
      throw new WebBootstrapUnavailableError(
        "The selected local-password provider is unavailable",
      );
    }
    this.#consumeRateLimit(rateLimitKey);
    return this.#identity.initializeAdministrator(
      username,
      displayName,
      providerInstanceId,
      { username, password },
    );
  }

  /** Bounds expensive public credential creation attempts per client address. */
  #consumeRateLimit(key: string): void {
    const now = Date.now();
    const current = this.#rateLimits.get(key);
    if (current === undefined || current.resetsAt <= now) {
      this.#rateLimits.set(key, {
        count: 1,
        resetsAt: now + RATE_LIMIT_WINDOW_MS,
      });
      return;
    }
    if (current.count >= RATE_LIMIT_ATTEMPTS) {
      throw new WebBootstrapRateLimitError("Web bootstrap rate limit exceeded");
    }
    current.count += 1;
  }
}

/** Selects only healthy instances of the built-in local-password plugin. */
function isAvailableLocalPassword(
  provider: AuthProviderPublicDescriptor,
): boolean {
  return (
    provider.pluginId === LOCAL_PASSWORD_PLUGIN_ID &&
    provider.availability === "available"
  );
}

/** Rejects malformed core fields before invoking provider-owned validation. */
function validateInput(
  providerInstanceId: string,
  username: string,
  displayName: string,
  password: string,
): void {
  if (
    providerInstanceId.length === 0 ||
    providerInstanceId.length > 128 ||
    username.length === 0 ||
    username.length > 200 ||
    displayName.length === 0 ||
    displayName.length > 200 ||
    password.length === 0 ||
    password.length > 1024
  ) {
    throw new WebBootstrapInputError("First-user setup input is invalid");
  }
}
